const parser = require('sax2json');
const axios = require('axios');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);

// CORS middleware
app.all('*', (req, res, next) => {
  const origin = req.get('origin');
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, X-HTTP-Method-Override, Origin, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET');
  next();
});

app.get('*', async (req, res) => {
  try {
    const header = req.headers['authorization'] || '';
    const token = header.split(/\s+/).pop() || '';
    const auth = Buffer.from(token, 'base64').toString();
    const parts = auth.split(/:/);
    const username = parts[0];
    const password = parts[1];
    const newApi = req.query['auth_token'];

    if ((!username || !password) && !newApi) {
      return res.status(401).json({ error: 'Not Authorized' });
    }

    const baseUrl = 'https://api.pinboard.in/v1';
    let url = `${baseUrl}${req.path}?`;

    const axiosConfig = {};
    if (!newApi) {
      axiosConfig.auth = {
        username,
        password
      };
    }

    const query = new URLSearchParams(req.query).toString();
    url += query;

    const response = await axios.get(url, axiosConfig);
    const { data, status } = response;

    if (status !== 200) {
      return res.status(status).send(data);
    }

    if (req.query['format'] === 'json') {
      return res.json(data);
    }

    parser.toJson(data, (err, obj) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to parse XML response' });
      }
      res.json(obj);
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({ error: error.response.data });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 1337;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
