import { env } from './config/env';
import app from './app';
import { connectDatabase } from './config/db';
import { announceAssistantProvider } from './services/assistant/assistant.service';
import { startNotificationProcessor } from './services/notification.service';

async function bootstrap(): Promise<void> {
  try {
    await connectDatabase();
    // Sends queued e-mails in the background; does nothing while EMAIL_ENABLED is false.
    if (startNotificationProcessor()) console.log(`E-mail notifications on (${env.EMAIL_PROVIDER})`);
    app.listen(env.PORT, () => {
      console.log(`Server running on http://localhost:${env.PORT}`);
      // Which assistant provider answers, and why (no key or address is printed). No model call.
      announceAssistantProvider();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
