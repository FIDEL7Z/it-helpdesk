import 'dotenv/config';
import app from './app';
import { connectDatabase } from './config/db';

const PORT = Number(process.env.PORT) || 3000;

async function bootstrap(): Promise<void> {
  try {
    await connectDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
