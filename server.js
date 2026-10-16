const express = require('express');
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'tamlaglobal@gmail.com',
    pass: 'wjxhsxgfggwdwfku'
  }
});

app.get('/', (req, res) => {
  res.send('Trade Beats Scanner is active');
});

app.post('/send-alert', async (req, res) => {
  try {
    const { symbol, message } = req.body;
    const mailOptions = {
      from: 'tamlaglobal@gmail.com',
      to: 'tamlaglobal@gmail.com',
      subject: `Forex Alert: ${symbol || 'Market Update'}`,
      text: message || 'A new market activity trigger was detected.'
    };
    await transporter.sendMail(mailOptions);
    res.status(200).send('Email sent successfully');
  } catch (error) {
  console.error('FULL ALERT ERROR:', error);
  res.status(500).json({ success: false, error: error.message || error.toString() });

  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
