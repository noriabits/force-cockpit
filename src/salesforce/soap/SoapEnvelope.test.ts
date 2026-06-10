import { describe, expect, it } from 'vitest';
import { buildExecuteAnonymousEnvelope, type ApexLogLevel } from './SoapEnvelope';

const DEFAULT_LEVELS: Record<string, ApexLogLevel> = {
  Db: 'NONE',
  Workflow: 'NONE',
  Apex_code: 'DEBUG',
};

describe('buildExecuteAnonymousEnvelope', () => {
  it('embeds the session id in the SessionHeader', () => {
    const xml = buildExecuteAnonymousEnvelope('System.debug(1);', 'SESSION_123', DEFAULT_LEVELS);
    expect(xml).toContain('<apex:sessionId>SESSION_123</apex:sessionId>');
  });

  it('XML-escapes &, < and > in the apex body', () => {
    const xml = buildExecuteAnonymousEnvelope('if (a < b && c > d) {}', 'S', DEFAULT_LEVELS);
    expect(xml).toContain('if (a &lt; b &amp;&amp; c &gt; d) {}');
    // The raw, unescaped characters must not leak into the apex String node
    expect(xml).not.toContain('a < b');
    expect(xml).not.toContain('c > d');
  });

  it('escapes & before < and > so entities are not double-escaped', () => {
    const xml = buildExecuteAnonymousEnvelope('a < b', 'S', DEFAULT_LEVELS);
    expect(xml).toContain('a &lt; b');
    expect(xml).not.toContain('&amp;lt;');
  });

  it('emits a category block only for non-NONE levels', () => {
    const xml = buildExecuteAnonymousEnvelope('x;', 'S', {
      Db: 'NONE',
      Apex_code: 'DEBUG',
      Callout: 'FINEST',
    });
    expect(xml).toContain('<apex:category>Apex_code</apex:category>');
    expect(xml).toContain('<apex:level>DEBUG</apex:level>');
    expect(xml).toContain('<apex:category>Callout</apex:category>');
    expect(xml).toContain('<apex:level>FINEST</apex:level>');
    // NONE categories are filtered out entirely
    expect(xml).not.toContain('<apex:category>Db</apex:category>');
  });

  it('produces an empty DebuggingHeader when every level is NONE', () => {
    const xml = buildExecuteAnonymousEnvelope('x;', 'S', { Db: 'NONE', Apex_code: 'NONE' });
    expect(xml).not.toContain('<apex:category>');
  });

  it('wraps the apex code in the executeAnonymous String node', () => {
    const xml = buildExecuteAnonymousEnvelope('System.debug(42);', 'S', DEFAULT_LEVELS);
    expect(xml).toContain('<apex:String>System.debug(42);</apex:String>');
  });
});
