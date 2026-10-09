import { env } from './config/env';
import app from './app';
import { connectDatabase } from './config/db';

async function bootstrap(): Promise<void> {
  try {
    await connectDatabase();
    app.listen(env.PORT, () => {
      console.log(`Server running on http://localhost:${env.PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
