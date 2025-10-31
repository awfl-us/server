import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import jobRoutes from './jobs/index.js';
import workflowsRoutes from './workflows/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Serve static files from "web" directory
app.use(express.static(path.join(__dirname, '../web')));

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
