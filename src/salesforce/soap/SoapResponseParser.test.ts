import { describe, expect, it } from 'vitest';
import { extractXmlValue, parseExecuteAnonymousResponse } from './SoapResponseParser';

const SUCCESS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header>
    <DebuggingInfo>
      <debugLog>USER_DEBUG|[1]|DEBUG|Hello World</debugLog>
    </DebuggingInfo>
  </soapenv:Header>
  <soapenv:Body>
    <executeAnonymousResponse>
      <result>
        <compiled>true</compiled>
        <success>true</success>
        <compileProblem xsi:nil="true"/>
        <exceptionMessage xsi:nil="true"/>
        <exceptionStackTrace xsi:nil="true"/>
      </result>
    </executeAnonymousResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

const COMPILE_ERROR_XML = `<result>
  <compiled>false</compiled>
  <success>false</success>
  <compileProblem>Unexpected token &apos;}&apos;.</compileProblem>
  <line>3</line>
</result>`;

const EXECUTION_ERROR_XML = `<result>
  <compiled>true</compiled>
  <success>false</success>
  <exceptionMessage>System.NullPointerException: Attempt to de-reference a null object</exceptionMessage>
  <exceptionStackTrace>AnonymousBlock: line 2, column 1</exceptionStackTrace>
  <debugLog>some log</debugLog>
</result>`;

describe('parseExecuteAnonymousResponse', () => {
  it('parses a successful execution with debug log', () => {
    const result = parseExecuteAnonymousResponse(SUCCESS_XML);
    expect(result.compiled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.compileProblem).toBeNull();
    expect(result.exceptionMessage).toBeNull();
    expect(result.exceptionStackTrace).toBeNull();
    expect(result.debugLog).toBe('USER_DEBUG|[1]|DEBUG|Hello World');
  });

  it('parses a compile error and decodes entities in the problem text', () => {
    const result = parseExecuteAnonymousResponse(COMPILE_ERROR_XML);
    expect(result.compiled).toBe(false);
    expect(result.success).toBe(false);
    expect(result.compileProblem).toBe("Unexpected token '}'.");
    expect(result.debugLog).toBe('');
  });

  it('parses an execution error with message and stack trace', () => {
    const result = parseExecuteAnonymousResponse(EXECUTION_ERROR_XML);
    expect(result.compiled).toBe(true);
    expect(result.success).toBe(false);
    expect(result.exceptionMessage).toContain('NullPointerException');
    expect(result.exceptionStackTrace).toBe('AnonymousBlock: line 2, column 1');
    expect(result.debugLog).toBe('some log');
  });

  it('returns nulls / empty defaults when fields are absent', () => {
    const result = parseExecuteAnonymousResponse('<result></result>');
    expect(result.compiled).toBe(false);
    expect(result.success).toBe(false);
    expect(result.compileProblem).toBeNull();
    expect(result.debugLog).toBe('');
  });
});

describe('extractXmlValue', () => {
  it('extracts a value regardless of namespace prefix', () => {
    expect(extractXmlValue('<soapenv:success>true</soapenv:success>', 'success')).toBe('true');
    expect(extractXmlValue('<success>true</success>', 'success')).toBe('true');
  });

  it('returns empty string when the tag is missing', () => {
    expect(extractXmlValue('<foo>bar</foo>', 'success')).toBe('');
  });

  it('decodes named entities', () => {
    expect(extractXmlValue('<v>&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;</v>', 'v')).toBe(
      `<a> & "b" 'c'`,
    );
  });

  it('decodes hex and decimal numeric character references', () => {
    expect(extractXmlValue('<v>&#x41;&#66;</v>', 'v')).toBe('AB');
  });

  it('decodes amp last so &amp;lt; becomes &lt; not <', () => {
    expect(extractXmlValue('<v>&amp;lt;</v>', 'v')).toBe('&lt;');
  });

  it('trims surrounding whitespace', () => {
    expect(extractXmlValue('<v>  hi  </v>', 'v')).toBe('hi');
  });
});
