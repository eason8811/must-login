import {generateSignForUrl, type SignOptions} from '@must/login';
import {generateCastleToken, type CastleOptions} from '@must/login';
import {getAuthorizationToken, type AuthorizationOptions} from '@must/login';

const options: SignOptions = {verbose: false, allowRemoteSdkExecution: true};
const castleOptions: CastleOptions = {allowRemoteSdkExecution: true, verbose: false};
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
      'x-guest-token': '2118363370009284698',
      'x-jf-client-theme': 'dark',
      'x-jf-v': 'JP-5',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'zh-cn',
      'cookie': 'guest_id=v1%3A179208205565679855; __cuid=16c4f5b3-619c-4dad-b691-fb8712c1c250; __cf_bm=2AGp51vp09xhTFaGjXl34dVZE2WidGFKjZgdhWivqQM-1793892146.7123194-1.0.1.1-F2989FAiKh27VeoYD.EUamxKzJl15PviJTpEzSQrXxU.cqjSZ9UVOH37tIp_T2aOHm9m_sjD5nbpLO7AhgiIZjsRvIAzTIsfpmiisvbYBg1DZr3wGlfdcJPMdCC7TvjN; gt=2118363370009284698'
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

