import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import healthRoutes from './routes/health.routes';
import authRoutes from './routes/auth.routes';
import dashboardRoutes from './routes/dashboard.routes';
import incidentRoutes from './routes/incident.routes';
import articleRoutes from './routes/article.routes';
import ticketRoutes from './routes/ticket.routes';
import userRoutes from './routes/user.routes';
import organizationRoutes from './routes/organization.routes';
import inventoryRoutes from './routes/inventory.routes';
import accountRoutes from './routes/account.routes';
import assistantRoutes from './routes/assistant.routes';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';

const app = express();

// Do not advertise the framework in every response.
app.disable('x-powered-by');

app.use(cors({ origin: env.CORS_ORIGIN }));
// Explicit body size limit: the largest valid payload (a ticket description) is ~5 KB.
app.use(express.json({ limit: '100kb' }));

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/api/articles', articleRoutes);
app.use('/api/users', userRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/assistant', assistantRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
