import login = require('@must/login');

const signature: Promise<string> = login.generateSign('jf', 'PATCH', {
  allowRemoteSdkExecution: true,
});

void signature;
const requestSignature: Promise<string | undefined> = login.generateSignForUrl('https://jf.x.com/', 'GET', {
  allowRemoteSdkExecution: true,
});
void requestSignature;
