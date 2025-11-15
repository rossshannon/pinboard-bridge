const { XMLParser } = require('fast-xml-parser');
const axios = require('axios');
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// Environment variable validation
const PORT = process.env.PORT || 1337;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : null; // null means allow all origins (for backward compatibility)

// Log startup configuration
console.log(`Starting Pinboard Bridge in ${NODE_ENV} mode`);
console.log(`Port: ${PORT}`);
console.log(`CORS: ${ALLOWED_ORIGINS ? `Restricted to ${ALLOWED_ORIGINS.length} origins` : 'All origins allowed (set ALLOWED_ORIGINS env var for security)'}`);

const app = express();
const server = http.createServer(app);

// Trust proxy - required for rate limiting behind Heroku
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Not needed for API
  crossOriginEmbedderPolicy: false,
}));

// Rate limiting - 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: { error: 'Too many requests, please try again later.' },
});

app.use('/v1/', limiter);

// CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);

    // If ALLOWED_ORIGINS is not set, allow all origins (backward compatibility)
    if (!ALLOWED_ORIGINS) return callback(null, true);

    // Check if origin is in whitelist
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With', 'X-HTTP-Method-Override', 'Origin', 'Accept', 'Authorization'],
};

app.use(cors(corsOptions));

// Respond immediately to CORS preflight checks
app.options('*', cors(corsOptions));

// Surface CORS rejections as JSON 403 errors
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed by CORS policy' });
  }

  console.error('Middleware error:', err.message);
  return res.status(500).json({ error: 'Internal server error' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// XML parser configuration
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

// Axios configuration with timeout
const axiosConfig = {
  timeout: 30000, // 30 seconds timeout
};

// Main proxy handler
app.get('/v1/*', async (req, res) => {
  try {
    const authHeader = req.get('authorization') || '';
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const basicMatch = authHeader.match(/^Basic\s+(.+)$/i);

    let requestConfig = { ...axiosConfig };
    const queryParams = new URLSearchParams(req.query);
    queryParams.delete('auth_token');

    if (basicMatch) {
      const encoded = basicMatch[1];
      const decoded = Buffer.from(encoded, 'base64').toString();
      const [username, password] = decoded.split(/:/);

      if (!username || !password) {
        return res.status(401).json({ error: 'Invalid Basic authorization header' });
      }

      requestConfig = {
        ...requestConfig,
        auth: { username, password }
      };
    } else if (bearerMatch) {
      const authToken = bearerMatch[1].trim();

      if (!authToken.includes(':')) {
        return res.status(401).json({ error: 'Invalid Bearer authorization header' });
      }

      queryParams.set('auth_token', authToken);
    } else {
      return res.status(401).json({ error: 'Authorization header required' });
    }

    // Build Pinboard API URL
    const baseUrl = 'https://api.pinboard.in';
    const path = req.path; // This includes /v1/...
    let url = `${baseUrl}${path}`;

    const queryString = queryParams.toString();
    if (queryString) {
      url += `?${queryString}`;
    }

    // Make request to Pinboard API
    const response = await axios.get(url, requestConfig);
    const { data, status } = response;

    if (status !== 200) {
      return res.status(status).send(data);
    }

    // If response is already JSON, return it
    if (req.query['format'] === 'json' || typeof data === 'object') {
      return res.json(data);
    }

    // Parse XML to JSON
    try {
      const jsonData = xmlParser.parse(data);
      res.json(jsonData);
    } catch (parseError) {
      console.error('XML parsing error:', parseError.message);
      return res.status(500).json({ error: 'Failed to parse XML response' });
    }
  } catch (error) {
    // Handle Axios errors
    if (error.response) {
      const status = error.response.status;
      const errorMessage = typeof error.response.data === 'string'
        ? error.response.data
        : error.response.data?.error || 'API request failed';
      return res.status(status).json({ error: errorMessage });
    }

    // Handle timeout errors
    if (error.code === 'ECONNABORTED') {
      console.error('Request timeout:', error.message);
      return res.status(504).json({ error: 'Gateway timeout' });
    }

    // Handle other errors
    console.error('Server error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown
const shutdown = () => {
  console.log('\nReceived shutdown signal, closing server gracefully...');

  server.close(() => {
    console.log('Server closed. Exiting process.');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
