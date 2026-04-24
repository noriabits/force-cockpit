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
