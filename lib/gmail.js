const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolvePath(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function toHtml(text) {
  return '<p>' +
    text
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\n\n+/g, '</p><p>')
      .replace(/\n/g, '<br>') +
    '</p>';
}

// Send via Gmail API using existing OAuth client from sheets
async function sendViaOAuth(oauthClient, to, subject, body) {
  const gmail = google.gmail({ version: 'v1', auth: oauthClient });
  const raw = Buffer.from(
    `To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${body}`
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// Send via nodemailer with Gmail App Password
async function sendViaAppPassword(gmailAuth, to, subject, body, attachmentPath) {
  const password = process.env[gmailAuth.passwordEnvVar];
  if (!password) throw new Error(`Missing env var: ${gmailAuth.passwordEnvVar}`);

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: gmailAuth.email, pass: password },
  });

  const mail = {
    from: `"${gmailAuth.displayName || gmailAuth.email}" <${gmailAuth.email}>`,
    to,
    subject,
    text: body,
  };

  if (attachmentPath && fs.existsSync(attachmentPath)) {
    mail.attachments = [{ filename: path.basename(attachmentPath), path: attachmentPath }];
  }

  await transporter.sendMail(mail);
}

// Create draft via IMAP (App Password clients)
async function createDraftViaImap(gmailAuth, to, subject, body, attachmentPath) {
  const password = process.env[gmailAuth.passwordEnvVar];
  if (!password) throw new Error(`Missing env var: ${gmailAuth.passwordEnvVar}`);

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: gmailAuth.email, pass: password },
    logger: false,
  });
  await client.connect();

  const htmlBody = toHtml(body);
  let raw;

  if (attachmentPath && fs.existsSync(attachmentPath)) {
    const boundary = `boundary_${Date.now()}`;
    const pdfData = fs.readFileSync(attachmentPath).toString('base64');
    const filename = path.basename(attachmentPath);
    raw = [
      `From: "${gmailAuth.displayName || gmailAuth.email}" <${gmailAuth.email}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      '',
      htmlBody,
      '',
      `--${boundary}`,
      `Content-Type: application/pdf; name="${filename}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      pdfData,
      '',
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    raw = [
      `From: "${gmailAuth.displayName || gmailAuth.email}" <${gmailAuth.email}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=utf-8`,
      '',
      htmlBody,
    ].join('\r\n');
  }

  await client.append('[Gmail]/Drafts', raw, ['\\Draft']);
  await client.logout();
}

async function send(clientConfig, oauthClient, to, subject, body, attachmentPath) {
  const gmailAuth = clientConfig.auth.gmail;
  if (gmailAuth.method === 'oauth') {
    await sendViaOAuth(oauthClient, to, subject, body);
  } else {
    await sendViaAppPassword(gmailAuth, to, subject, body, attachmentPath);
  }
}

async function createDraft(clientConfig, to, subject, body, attachmentPath) {
  const gmailAuth = clientConfig.auth.gmail;
  if (gmailAuth.method === 'app-password') {
    await createDraftViaImap(gmailAuth, to, subject, body, attachmentPath);
  } else {
    throw new Error('OAuth draft creation not yet implemented');
  }
}

module.exports = { send, createDraft };
