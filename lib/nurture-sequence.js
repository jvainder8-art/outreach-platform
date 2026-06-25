const fs = require('fs');
const path = require('path');
const { getRows, updateRow } = require('./sheets');
const { generate } = require('./ai');
const { send, createDraft } = require('./gmail');

function log(clientName, msg) {
  console.log(`[${new Date().toLocaleString()}] [${clientName}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function daysSince(dateStr) {
  if (!dateStr) return 9999;
  const s = dateStr.trim();
  const normalized = s.includes(' ') ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(normalized);
  if (isNaN(d)) return 9999;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

function isTomorrow(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr.trim().replace(' ', 'T') + 'Z');
  if (isNaN(d)) return false;
  const tomorrowET = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const meetDateET = d.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  return meetDateET === tomorrowET;
}

function formatMeetGreetDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr.trim().replace(' ', 'T') + 'Z');
  if (isNaN(d)) return dateStr;
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZoneName: 'short',
  });
}

function resolveGlob(pattern) {
  if (!pattern) return null;
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  const regex = new RegExp('^' + base.replace(/\*/g, '.*') + '$');
  try {
    const files = fs.readdirSync(dir).filter(f => regex.test(f));
    return files.length > 0 ? path.join(dir, files[0]) : null;
  } catch {
    return null;
  }
}

function interpolate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

function loadSystemPrompt(clientDir) {
  const p = path.join(clientDir, 'prompts', 'system.txt');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function loadStepPrompt(clientDir, step, vars) {
  const p = path.join(clientDir, 'prompts', `step-${step}.txt`);
  if (!fs.existsSync(p)) throw new Error(`Missing prompt file: ${p}`);
  return interpolate(fs.readFileSync(p, 'utf8'), vars);
}

function determineStep(row, cols, sequence) {
  const lastEmail = parseInt(row[cols.lastEmail] || '0', 10);
  const lastEmailDate = (row[cols.lastEmailDate] || '').trim();
  const meetGreetDate = (row[cols.meetGreetDate] || '').trim();

  for (const step of sequence) {
    if (step.trigger === 'new' && lastEmail === 0) return step;
    if (step.trigger === 'meeting-tomorrow' && lastEmail === step.step - 1 && meetGreetDate && isTomorrow(meetGreetDate)) return step;
    if (step.trigger === 'meeting-past' && lastEmail === step.step - 1 && meetGreetDate && daysSince(meetGreetDate) >= (step.delayDays || 1)) return step;
    if (step.trigger === 'step-sent' && lastEmail === step.afterStep && daysSince(lastEmailDate) >= step.delayDays) return step;
  }

  return null;
}

async function run(clientConfig, clientDir) {
  const name = clientConfig.name;
  log(name, 'Starting nurture sequence run...');

  const cols = clientConfig.columns;
  const range = clientConfig.sheetRange || 'A2:K';
  const { rows, auth } = await getRows(clientConfig.auth.sheets, clientConfig.sheetId, range);

  const systemPrompt = loadSystemPrompt(clientDir);
  const skipStages = clientConfig.skipStages || [];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const seen = new Set();
  let processed = 0;

  const welcomePacketPath = process.env.DRVCARES_WELCOME_PACKET_PATH
    || resolveGlob(clientConfig.welcomePacketGlob);

  const needsPacket = clientConfig.sequence.some(s => s.attachWelcomePacket);
  if (needsPacket && !welcomePacketPath) {
    log(name, 'WARNING: No welcome packet found — emails with attachWelcomePacket will send without attachment. Set DRVCARES_WELCOME_PACKET_B64 secret to fix.');
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const email = (row[cols.email] || '').trim();
    if (!email || !email.includes('@')) continue;
    if (seen.has(email)) { log(name, `Skipping duplicate: ${email}`); continue; }

    const stage = (row[cols.stage] || '').toLowerCase().trim();
    if (skipStages.includes(stage)) continue;

    const step = determineStep(row, cols, clientConfig.sequence);
    if (!step) continue;

    const parentName = (row[cols.parentName] || '').trim();
    const childInfo = (row[cols.childInfo] || '').trim();
    const howFound = (row[cols.howFound] || '').trim();
    const notes = (row[cols.notes] || '').trim();
    const meetGreetDate = (row[cols.meetGreetDate] || '').trim();
    const formattedMeetDate = formatMeetGreetDate(meetGreetDate);

    const vars = {
      parentName: parentName || 'the parent',
      childDesc: childInfo ? `their child (${childInfo})` : 'their child',
      howFoundLine: howFound ? `They found ${name} via: ${howFound}.` : '',
      notesLine: notes ? `Parent's notes/concerns: ${notes}.` : '',
      meetGreetDateLine: formattedMeetDate ? `Their meet & greet was on ${formattedMeetDate}.` : '',
      meetGreetDate: formattedMeetDate,
    };

    try {
      log(name, `Generating Email ${step.step} for ${parentName} (${email})...`);
      const userPrompt = loadStepPrompt(clientDir, step.step, vars);
      const raw = await generate(clientConfig.ai, systemPrompt, userPrompt);

      const subjectMatch = raw.match(/^SUBJECT:\s*(.+)/m);
      const bodyMatch = raw.match(/^BODY:\s*\n([\s\S]+)/m);
      const subject = subjectMatch ? subjectMatch[1].trim() : `Follow-up — ${name}`;
      const body = bodyMatch ? bodyMatch[1].trim() : raw;

      const attachmentPath = step.attachWelcomePacket ? welcomePacketPath : null;

      if (step.mode === 'send') {
        await send(clientConfig, auth, email, subject, body, attachmentPath);
        log(name, `Sent Email ${step.step} to ${email}`);
      } else {
        await createDraft(clientConfig, email, subject, body, attachmentPath);
        log(name, `Draft created for ${parentName} — check ${clientConfig.auth.gmail.email} Drafts`);
      }

      const rowNum = i + 2;
      await updateRow(auth, clientConfig.sheetId,
        `Sheet1!H${rowNum}:I${rowNum}`, [String(step.step), today]);

      seen.add(email);
      processed++;
      await sleep(2000);
    } catch (err) {
      log(name, `Failed for ${email}: ${err.message}`);
    }
  }

  log(name, `Done. ${processed} email(s) processed.`);
}

module.exports = { run };
