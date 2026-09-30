// Vercel entry: the whole Express app runs as one serverless function; vercel.json rewrites every non-static path here.
import { createApp } from '../server/index.js';

const { app } = createApp(process.env);
export default app;
