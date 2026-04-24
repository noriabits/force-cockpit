// Builds the SOAP envelope used by executeAnonymousWithDebugLog.
// Pure string manipulation — no I/O.

export type ApexLogLevel =
  | 'NONE'
  | 'ERROR'
  | 'WARN'
  | 'INFO'
  | 'DEBUG'
  | 'FINE'
  | 'FINER'
  | 'FINEST';

export function buildExecuteAnonymousEnvelope(
  apexBody: string,
  sessionId: string,
  logLevels: Record<string, ApexLogLevel>,
): string {
  const escapedApex = apexBody.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const categories = Object.entries(logLevels)
    .filter(([, level]) => level !== 'NONE')
    .map(
      ([category, level]) => `
        <apex:categories>
          <apex:category>${category}</apex:category>
          <apex:level>${level}</apex:level>
        </apex:categories>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="utf-8"?>
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:apex="http://soap.sforce.com/2006/08/apex">
        <soapenv:Header>
          <apex:DebuggingHeader>${categories}
          </apex:DebuggingHeader>
          <apex:SessionHeader>
            <apex:sessionId>${sessionId}</apex:sessionId>
          </apex:SessionHeader>
        </soapenv:Header>
        <soapenv:Body>
          <apex:executeAnonymous>
            <apex:String>${escapedApex}</apex:String>
          </apex:executeAnonymous>
        </soapenv:Body>
      </soapenv:Envelope>`;
}
