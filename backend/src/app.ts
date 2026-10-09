import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import healthRoutes from './routes/health.routes';
import authRoutes from './routes/auth.routes';
import dashboardRoutes from './routes/dashboard.routes';
import ticketRoutes from './routes/ticket.routes';
import userRoutes from './routes/user.routes';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';

const app = express();

app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json());

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/users', userRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
