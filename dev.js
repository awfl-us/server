import express from 'express';
import jobRoutes from './jobs/index.js';
import workflowsRoutes from './workflows/index.js';

const app = express();
// app.use(cors({ origin: true }));

app.use(express.json({ limit: '1mb' }));

const logging = (req, res, next) => {
  const { method, url, headers, body } = req;
  if (!url.includes("/health")) {
    console.log(`[Request] Method: ${method}, URL: ${url}, Headers: ${JSON.stringify(headers)}, Body: ${JSON.stringify(body)}`);
  }
  next();
};

app.use(logging);

app.get('/api/health', (req, res) => res.status(200).send('OK'));

// API and Jobs routes
app.use('/api/workflows', workflowsRoutes);
app.use('/jobs', jobRoutes);

// SPA fallback
app.get('*', (req, res) => {
  res.status(404).send('<h1>404 Not Found</h1><p>The page you are looking for does not exist.</p>');
});

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`🚀 Local dev server running at http://localhost:${PORT}`);
});
