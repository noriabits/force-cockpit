// Parses the SOAP XML response from executeAnonymousWithDebugLog.
// Regex-based extraction — avoids pulling in a full XML parser for this narrow use case.

export interface ExecuteAnonymousSoapResult {
  compiled: boolean;
  success: boolean;
  compileProblem: string | null;
  exceptionMessage: string | null;
  exceptionStackTrace: string | null;
  debugLog: string;
}

/**
 * True when the response is a SOAP fault caused by an expired/invalid session.
 * `postSoapRequest` resolves with the raw XML whatever the HTTP status, so this is the
 * only signal that the token embedded in the envelope was rejected.
 */
export function isSoapSessionExpired(xmlResponse: string): boolean {
  if (!/<[^:]*:?Fault[\s>]/i.test(xmlResponse)) return false;
  return /INVALID_SESSION_ID/i.test(xmlResponse);
}

/** The `faultstring` of a SOAP fault response, or null when the response is not a fault. */
export function extractSoapFault(xmlResponse: string): string | null {
  if (!/<[^:]*:?Fault[\s>]/i.test(xmlResponse)) return null;
  const faultString = extractXmlValue(xmlResponse, 'faultstring');
  const faultCode = extractXmlValue(xmlResponse, 'faultcode');
  return faultString || faultCode || 'Unknown SOAP fault';
}

export function parseExecuteAnonymousResponse(xmlResponse: string): ExecuteAnonymousSoapResult {
  return {
    compiled: extractXmlValue(xmlResponse, 'compiled') === 'true',
    success: extractXmlValue(xmlResponse, 'success') === 'true',
    compileProblem: extractXmlValue(xmlResponse, 'compileProblem') || null,
    exceptionMessage: extractXmlValue(xmlResponse, 'exceptionMessage') || null,
    exceptionStackTrace: extractXmlValue(xmlResponse, 'exceptionStackTrace') || null,
    debugLog: extractXmlValue(xmlResponse, 'debugLog') || '',
  };
}

export function extractXmlValue(xml: string, tagName: string): string {
  const regex = new RegExp(`<[^:]*:?${tagName}[^>]*>([\\s\\S]*?)<\\/[^:]*:?${tagName}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';
  return match[1]
    .trim()
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
