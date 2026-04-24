// HTTPS/HTTP transport for the Salesforce SOAP API. Returns the raw XML body.

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export function postSoapRequest(
  instanceUrl: string,
  apiVersion: string,
  soapEnvelope: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/services/Soap/s/${apiVersion}`, instanceUrl);
    const body = Buffer.from(soapEnvelope, 'utf-8');
    const options = {
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '""',
        'Content-Length': body.length,
        'Accept-Encoding': 'identity', // prevent gzip — we read raw bytes as UTF-8 string
      },
    };
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
