import hljs from 'highlight.js/lib/core';
import apex from 'highlightjs-apex';
import javascript from 'highlight.js/lib/languages/javascript';
import bash from 'highlight.js/lib/languages/bash';

hljs.registerLanguage('apex', apex);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('bash', bash);

window.hljs = hljs;
