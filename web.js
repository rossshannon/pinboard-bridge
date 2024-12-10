const parser = require('sax2json');
const request = require('request');
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

app.get('*', (req, res) => {
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

    if (!newApi) {
      url = url.replace('https://', `https://${username}:${password}@`);
    }

    const query = new URLSearchParams(req.query).toString();
    url += query;

    request({ url }, (error, response, body) => {
      if (error) {
        return res.status(500).json({ error: 'Failed to fetch from Pinboard API' });
      }

      if (response.statusCode !== 200) {
        return res.status(response.statusCode).send(body);
      }

      if (req.query['format'] === 'json') {
        try {
          return res.json(JSON.parse(body));
        } catch (e) {
          return res.status(500).json({ error: 'Failed to parse JSON response' });
        }
      }

      parser.toJson(body, (err, obj) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to parse XML response' });
        }
        res.json(obj);
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 1337;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
