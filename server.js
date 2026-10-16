const express = require('express');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

const resend = new Resend('re_c7qBvNAT_8C6Zm1Z37xjiRe9RAFw6ezHd');

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Trade Beats Scanner is active');
});

app.post('/send-alert', async (req, res) => {
  try {
    const { symbol, message } = req.body;

    const data = await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: 'tamlaglobal@gmail.com',
      subject: `Forex Alert: ${symbol || 'Market Update'}`,
      text: message || 'A new market activity trigger was detected.'
    });

    console.log('Email sent successfully:', data);
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('FULL ALERT ERROR:', error);
    res.status(500).json({ success: false, error: error.message || error.toString() });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
