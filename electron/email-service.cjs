const nodemailer = require('nodemailer');

// QQ 邮箱 SMTP 配置
const QQ_EMAIL = process.env.QQ_EMAIL || '3189616067@qq.com';
const QQ_AUTH_CODE = process.env.QQ_AUTH_CODE || 'mwglijpekqffdfbd';

const transporter = nodemailer.createTransport({
  host: 'smtp.qq.com',
  port: 465,
  secure: true, // 使用 SSL
  auth: {
    user: QQ_EMAIL,
    pass: QQ_AUTH_CODE
  }
});

// 验证配置
transporter.verify(function (error, success) {
  if (error) {
    console.log('[Email] SMTP 配置错误:', error);
  } else {
    console.log('[Email] SMTP 服务器已就绪');
  }
});

/**
 * 发送验证码邮件
 * @param {string} to - 收件人邮箱
 * @param {string} code - 验证码
 */
async function sendVerificationCode(to, code) {
  try {
    const mailOptions = {
      from: `"Simona Desktop" <${QQ_EMAIL}>`,
      to: to,
      subject: 'Simona Desktop 登录验证码',
      html: `
        <div style="max-width: 600px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #CC7C5E; margin: 0;">Simona Desktop</h1>
          </div>
          
          <div style="background: #f9f9f9; padding: 30px; border-radius: 10px; text-align: center;">
            <h2 style="color: #333; margin-top: 0;">登录验证码</h2>
            <p style="color: #666; font-size: 14px;">您的验证码是：</p>
            <div style="font-size: 36px; font-weight: bold; color: #CC7C5E; letter-spacing: 5px; margin: 20px 0;">
              ${code}
            </div>
            <p style="color: #999; font-size: 12px;">验证码有效期为 5 分钟，请勿泄露给他人</p>
          </div>
          
          <div style="margin-top: 30px; text-align: center; color: #999; font-size: 12px;">
            <p>如果这不是您的操作，请忽略此邮件</p>
            <p>© 2024 Simona Desktop. All rights reserved.</p>
          </div>
        </div>
      `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('[Email] 验证码邮件已发送:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('[Email] 发送邮件失败:', error);
    throw error;
  }
}

module.exports = {
  sendVerificationCode
};
