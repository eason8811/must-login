import {generateSignForUrl, type SignOptions} from '@must/login';
import {generateCastleToken, type CastleOptions} from '@must/login';
import {getAuthorizationToken, type AuthorizationOptions} from '@must/login';

const cacheDir = 'E:\\Code\\codes\\must-login\\temp';
const options: SignOptions = {verbose: false, allowRemoteSdkExecution: true, cacheDirectory: cacheDir};
const castleOptions: CastleOptions = {allowRemoteSdkExecution: true, verbose: false, cacheDirectory: cacheDir};
const authorizationOptions: AuthorizationOptions = {verbose: false, fetchTimeoutMs: 15_000};

const assetsUrl = 'https://jf.x.com/onboarding/web/actions/begin_login';
const requestSignature: Promise<string | undefined> = generateSignForUrl(new URL(assetsUrl), 'PATCH', options);
const castleToken: Promise<string> = generateCastleToken(castleOptions);
const authorization: Promise<string> = getAuthorizationToken(authorizationOptions);

async function main() {
  let normalizedRequestSignature = await requestSignature;
  if (!normalizedRequestSignature)
    return;
  let resp = fetch(assetsUrl, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'accept-language': 'zh-cn',
      'authorization': await authorization,
      'cache-control': 'no-cache',
      'origin': 'https://x.com',
      'pragma': 'no-cache',
      'priority': 'u=1, i',
      'referer': 'https://x.com/',
      'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'timezone': 'Asia/Shanghai',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
      'x-client-transaction-id': normalizedRequestSignature,
      'x-guest-token': '2118571137802084368',
      'x-jf-client-theme': 'dark',
      'x-jf-v': 'JP-5',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'zh-cn',
      'cookie': 'gt=2118571137802084368; guest_id=v1%3A179394169504546514; __cf_bm=uTb60Em_CSHr5ISi.C_RTXXTXYpIaG5SIO1t0pQ9yZ8-1793941695.0256047-1.0.1.1-r1Wpq9TJRXuabWpCfwc2rYExhibk.aVezS.l6iIn2EHij6lzfveQicg0.011xVA3nCcPZSRwbLun2JKa82NPLYOXt.ahJpBiCWqCy9rpuZ_9l7pwBkL9Qm1jUTdQcnnx; __cuid=9f655789-d2bb-4659-9533-1d76aaf99e2d'
    },
    body: new URLSearchParams({
      'username_or_email': 'yanyan88111',
      'password': '20020226Hyj',
      '$castle_token': await castleToken
    })
  });

  let originalResp = await resp;

  console.dir(`arrayBuffer: ${await originalResp.clone().arrayBuffer()}`);
  console.dir(`text: ${await originalResp.clone().text()}`);
  console.dir(`bytes: ${await originalResp.clone().bytes()}`);
  console.dir(`blob: ${await originalResp.clone().blob()}`);

}

await main();

