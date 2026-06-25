const axios = require('axios');
const { getRows, updateRow } = require('./sheets');
const { generate } = require('./ai');
const { send } = require('./gmail');

function log(clientName, msg) {
  console.log(`[${new Date().toLocaleString()}] [${clientName}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function researchBrand(email) {
  try {
    const domain = email.split('@')[1];
    const res = await axios.get(`https://r.jina.ai/https://${domain}`, {
      timeout: 8000,
      headers: { Accept: 'text/plain' },
    });
    return (res.data || '').slice(0, 1500);
  } catch {
    return '';
  }
}

function buildEmail(config, firstName, personalLine) {
  const name = firstName || 'there';
  const p = config.persona;
  return `Hi ${name},

${p.intro}

${personalLine}

${p.cta}

${p.signature}`;
}

async function run(clientConfig) {
  const name = clientConfig.name;
  log(name, 'Starting cold outreach run...');

  const range = clientConfig.sheetRange || 'A:K';
  const { rows, auth } = await getRows(clientConfig.auth.sheets, clientConfig.sheetId, range);

  const emailCol = clientConfig.columns?.email ?? 2;
  const firstNameCol = clientConfig.columns?.firstName ?? 0;
  const statusCol = clientConfig.columns?.status ?? 7;
  const sentTodayCol = clientConfig.columns?.sentToday ?? (statusCol + 1);
  const limit = clientConfig.emailsPerRun || 5;
  const dailyCap = clientConfig.dailyCap || limit * 2;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const sentToday = rows.slice(1).filter(r => (r[sentTodayCol] || '').startsWith(today)).length;
  if (sentToday >= dailyCap) {
    log(name, `Daily cap reached (${sentToday}/${dailyCap}). Skipping.`);
    return;
  }
  const remaining = dailyCap - sentToday;

  const contacts = [];
  for (let i = 1; i < rows.length && contacts.length < Math.min(limit, remaining); i++) {
    const row = rows[i];
    const email = (row[emailCol] || '').trim();
    if (!email || !email.includes('@')) continue;
    const status = (row[statusCol] || '').toLowerCase().trim();
    if (status && status !== 'no status') continue;
    contacts.push({ rowNum: i + 1, firstName: (row[firstNameCol] || '').trim(), email });
  }

  if (contacts.length === 0) {
    log(name, 'No contacts to reach out to.');
    return;
  }

  log(name, `Sending to ${contacts.length} contacts...`);

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    try {
      const brandInfo = await researchBrand(contact.email);

      const prompt = brandInfo
        ? `Write ONE short sentence (under 20 words) that fits naturally in a cold outreach email from ${clientConfig.persona.bio}. Reference something specific and genuine about this brand. No emojis, no dashes, no exclamation points. Just the sentence.\n\nBrand content:\n${brandInfo}`
        : null;

      const personalLine = brandInfo
        ? await generate(clientConfig.ai, null, prompt)
        : 'I came across your brand and was genuinely drawn to what you are building.';

      const body = buildEmail(clientConfig, contact.firstName, personalLine);
      await send(clientConfig, auth, contact.email, clientConfig.persona.subject, body, null);

      const statusColLetter = String.fromCharCode(65 + statusCol);
      const sentTodayColLetter = String.fromCharCode(65 + sentTodayCol);
      await updateRow(auth, clientConfig.sheetId, `${statusColLetter}${contact.rowNum}`, ['Reached Out']);
      await updateRow(auth, clientConfig.sheetId, `${sentTodayColLetter}${contact.rowNum}`, [today]);
      log(name, `Sent: ${contact.email}`);

      if (i < contacts.length - 1) {
        const delay = 60000 + Math.random() * 60000;
        log(name, `Waiting ${Math.round(delay / 60000)} min...`);
        await sleep(delay);
      }
    } catch (err) {
      log(name, `Failed ${contact.email}: ${err.message}`);
      if (/invalid|not found/i.test(err.message)) {
        const statusColLetter = String.fromCharCode(65 + statusCol);
        await updateRow(auth, clientConfig.sheetId, `${statusColLetter}${contact.rowNum}`, ['Bounced']).catch(() => {});
      }
    }
  }

  log(name, 'Done.');
}

module.exports = { run };
