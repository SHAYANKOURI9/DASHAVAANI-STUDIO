// Email from the studio (password reset links), through the owner's own mail account over SMTP.
// Gmail: SMTP_HOST=smtp.gmail.com, SMTP_USER=you@gmail.com, SMTP_PASS=<a Google App Password>.
import nodemailer from "nodemailer";

export const mailReady = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transport;
export async function sendMail(to, subject, text) {
  if (!mailReady()) {
    // shortcut: without SMTP settings the message goes to the server's terminal, so the owner can still test resets; set SMTP_* before others use it.
    console.log(`\n[mail not set up] To: ${to}\nSubject: ${subject}\n\n${text}\n`);
    return;
  }
  const port = Number(process.env.SMTP_PORT ?? 465);
  transport ??= nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  await transport.sendMail({ from: process.env.MAIL_FROM || `Dashavani Studio <${process.env.SMTP_USER}>`, to, subject, text });
}
