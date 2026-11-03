import login = require('@must/login');

const client = login.createLoginClient(({ username }) => ({ name: username }));

void client;
