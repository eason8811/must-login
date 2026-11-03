import { createLoginClient, type LoginCredentials } from '@must/login';

const client = createLoginClient(async (credentials: LoginCredentials) => ({
  name: credentials.username,
}));

void client;
