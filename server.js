const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Trade Beats Scanner is active');
});

app.get('/price', async (req, res) => {
  const symbol = req.query.symbol || 'EUR/USD';
  const apiKey = process.env.TWELVE_DATA_API_KEY;

  try {
    const response = await fetch(`https://api.twelvedata.com/price?symbol=${symbol}&apikey=${apiKey}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch price data' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
