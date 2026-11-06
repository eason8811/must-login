import { generateSign, generateSignForUrl, shouldGenerateSign, type SignOptions } from '@must/login';
import { generateCastleToken, type CastleOptions } from '@must/login';
import { getAuthorizationToken, type AuthorizationOptions } from '@must/login';

const options: SignOptions = { verbose: false, allowRemoteSdkExecution: true };
const signature: Promise<string> = generateSign('jf', 'PATCH', options);

void signature;
const supported: boolean = shouldGenerateSign('https://jf.x.com/');
const requestSignature: Promise<string | undefined> = generateSignForUrl('https://jf.x.com/', 'PATCH', options);
void supported;
void requestSignature;
const castleOptions: CastleOptions = { allowRemoteSdkExecution: true, verbose: false };
const castleToken: Promise<string> = generateCastleToken(castleOptions);
void castleToken;
const authorizationOptions: AuthorizationOptions = { verbose: false, fetchTimeoutMs: 15_000, cacheDirectory: '/tmp/must-login-authorization' };
const authorization: Promise<string> = getAuthorizationToken(authorizationOptions);
void authorization;
