import nodemailer from "nodemailer";

let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 465;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass) {
    console.warn("⚠️ EMAIL_USER or EMAIL_PASS not set; email sending disabled");
    return null;
  }

  // If using Gmail with a Google App Password, use the Gmail service directly
  if (user.toLowerCase().endsWith("@gmail.com") || host?.includes("gmail")) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
  } else if (host) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // true for 465, false for 587
      auth: { user, pass },
    });
  } else {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
  }

  return transporter;
};

/**
 * Sends a branded OTP verification email
 */
export const sendOtpEmail = async (toEmail, code, purpose = "email_verification") => {
  const mailer = getTransporter();
  if (!mailer) {
    console.warn(`⚠️ Cannot send email to ${toEmail}: Transporter not configured.`);
    return false;
  }

  const purposeLabels = {
    email_verification: "Email Verification Code",
    phone_verification: "Verification Code",
    password_reset: "Password Reset Code",
  };

  const subject = `${code} is your Find A Nikah ${purposeLabels[purpose] || "Verification Code"}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f7f9fa; margin: 0; padding: 20px; }
    .container { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.06); border: 1px solid #edf2f7; }
    .header { background: linear-gradient(135deg, #0d9488 0%, #047857 100%); padding: 32px 20px; text-align: center; color: #ffffff; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
    .header p { margin: 6px 0 0; font-size: 14px; opacity: 0.9; }
    .body { padding: 32px 28px; color: #334155; line-height: 1.6; }
    .greeting { font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 12px; }
    .code-box { background: #f0fdf4; border: 2px dashed #0d9488; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0; }
    .code { font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #047857; font-family: monospace; }
    .footer { padding: 20px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; background: #fafafa; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Find A Nikah</h1>
      <p>Matrimony Platform</p>
    </div>
    <div class="body">
      <div class="greeting">Assalamu Alaikum,</div>
      <p>Please use the verification code below to complete your <strong>${purposeLabels[purpose] || "verification"}</strong>.</p>
      
      <div class="code-box">
        <div class="code">${code}</div>
      </div>

      <p style="font-size: 14px; color: #64748b;">
        ⏱️ This code is valid for <strong>5 minutes</strong> and can only be used once. Never share this code with anyone.
      </p>
      <p style="font-size: 13px; color: #94a3b8; margin-top: 24px;">
        If you did not request this verification, please safely ignore this email.
      </p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} Find A Nikah. All rights reserved.
    </div>
  </div>
</body>
</html>
  `;

  try {
    const fromAddress = process.env.EMAIL_USER;
    const info = await mailer.sendMail({
      from: `"Find A Nikah" <${fromAddress}>`,
      to: toEmail,
      subject,
      html,
    });
    console.log(`✉️ Email successfully sent to ${toEmail} (Message ID: ${info.messageId})`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send email to ${toEmail}:`, error.message);
    return false;
  }
};
