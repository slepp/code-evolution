import { readFileSync } from 'fs';
import ejs from 'ejs';
import { startSpan } from './tracing.mjs';

const TEMPLATE_URL = new URL('../templates/visualization.html.template', import.meta.url);
let templateCache = null;

function loadTemplate() {
  if (!templateCache) {
    templateCache = readFileSync(TEMPLATE_URL, 'utf8');
  }
  return templateCache;
}

function serializeForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function generateHTML(data, repoUrl) {
  const span = startSpan('analyzer.generate_html', {
    'analyzer.commits.count': data.results.length,
    'analyzer.languages.count': data.allLanguages.length
  });

  try {
    const template = loadTemplate();

    const html = ejs.render(template, {
      repoUrl,
      dataJson: serializeForHtml(data.results),
      allLanguagesJson: serializeForHtml(data.allLanguages),
      audioDataJson: serializeForHtml(data.audioData || [])
    });

    span.setStatus('ok');
    span.end();
    return html;
  } catch (err) {
    span.setStatus('error', err.message);
    span.recordException(err);
    span.end();
    throw err;
  }
}
