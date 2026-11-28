import test from 'node:test';
import assert from 'node:assert/strict';
import { manuscriptTex, readTemplate, typeset } from '../runtime/typesetting.ts';

test('attached journal templates retain supported class options and packages', () => {
  const preamble = ['\\documentclass[final,3p,times]{elsarticle}', '\\usepackage{booktabs}'];
  const parsed = readTemplate([...preamble, '\\begin{document}', 'Placeholder text', '\\end{document}'].join('\n'));
  assert.equal(parsed.style, 'elsarticle-3p');
  const tex = manuscriptTex('Current revision', 'Estimate: 95% & rising.', parsed.style, [], parsed.preamble);
  assert.ok(tex.startsWith(preamble.join('\n')));
  assert.ok(tex.includes('95\\% \\&'));
  assert.doesNotMatch(tex, /Placeholder text/);
  assert.throws(() => readTemplate('\\documentclass{article}\n\\newcommand{\\heading}{Study}\n\\begin{document}\n'), /Unsupported template directive/);
});

test('plots and tables use the selected numeric columns of the supplied version', () => {
  const sourceId = 'a'.repeat(64);
  const data = [{sourceId, rows:[{time:0, volts:-1}, {time:1, volts:0.6321}]}];
  const link = '![Charging](athena-plot:'+sourceId+'/time/volts)';
  const tex = manuscriptTex('Test', link+'\n'+link.replace('athena-plot', 'athena-table'), 'article', [], [], data);
  assert.match(tex, /\\begin\{picture\}/);
  assert.match(tex, /\\put\(169,75\)\{\\circle/);
  assert.ok(tex.includes('1 & 0.6321'));
  assert.throws(() => manuscriptTex('Test', link, 'article'), /reviewed experiment source/);
  assert.throws(() => manuscriptTex('Test', link.replace('/volts','/missing'), 'article', [], [], data), /missing or nonnumeric/);
  assert.throws(() => manuscriptTex('Test', '![Plot](missing.png)', 'article'), /unstaged figure/);
});

test('scientific minus and signed Unicode exponents survive PDF typesetting', () => {
  const tex=manuscriptTex('Experiment', 'Observed −1.18, tolerance 5 × 10⁻¹⁵ and 10⁰.', 'article');
  assert.ok(tex.includes('\\ensuremath{-}1.18'));
  assert.ok(tex.includes('5 \\ensuremath{\\times} 10\\textsuperscript{\\ensuremath{-15}}'));
  assert.ok(tex.includes('10\\textsuperscript{\\ensuremath{0}}'));
});

const paper={title:'A study of calibration',url:'https://doi.org/10.1234/Cal.24',retrievedAt:'2026-05-12'};
const supplement={title:'Another study',url:'https://example.org/papers/B',retrievedAt:'2026-05-13'};

test('the reviewed title and numbered references appear once; missing citations precede the appendix', () => {
  const markdown=['', '  # The reviewed title ###', '## Results', 'See [1–4].',
    '## References', '[1] Data.', '[2] Script.', '[3] Original CSV.',
    '[4] Author. A study of calibration. DOI 10.1234/cal.24.', '', '## Appendix', 'Details.'].join('\r\n');
  const tex=manuscriptTex('Earlier metadata title',markdown,'article',[paper,supplement]);
  assert.ok(tex.includes('\\title{The reviewed title}'));
  assert.doesNotMatch(tex,/Earlier metadata title|section\*{The reviewed title}/);
  assert.ok(tex.includes('See [1–4].'));
  assert.equal(tex.match(/\\section\*\{References\}/g)?.length,1);
  assert.match(tex,/\[1\] Data\.\n\[2\] Script\.\n\[3\] Original CSV\./);
  assert.ok(tex.includes('[4] Author. A study of calibration. DOI \\href{https://doi.org/10.1234/cal.24}{10.1234/cal.24}.'));
  assert.equal(tex.match(/A study of calibration/g)?.length,1);
  assert.ok(tex.indexOf('Another study')>tex.indexOf('[4] Author.'));
  assert.ok(tex.indexOf('Another study')<tex.indexOf('\\section*{Appendix}'));
});

test('section-only manuscripts keep the metadata title; body references never suppress bibliography', () => {
  const tex=manuscriptTex('Study','# Results\nSee https://doi.org/10.1234/cal.24.\n## Discussion\nMore.', 'article',[paper]);
  assert.ok(tex.includes('\\title{Study}'));
  assert.ok(tex.includes('\\section*{Results}'));
  assert.ok(tex.includes('\\section*{References}'));
  assert.ok(tex.includes('A study of calibration.'));
});

test('setext headings, DOI aliases, URLs, and identifier-free full titles can identify authored citations', () => {
  const markdown=['Reviewed title','====','Observations.','', 'Works Cited','----',
    '1. Author. Linked paper. <http://dx.doi.org/10.1234/CAL.24>.',
    '2. Dataset. [Archive](https://example.org/papers/B).',
    '3. Author. *Longitudinal observations*. 2025.'].join('\n');
  const refs=[paper,supplement,{...supplement,title:'Longitudinal observations',url:'https://example.com/long'}];
  const tex=manuscriptTex('Fallback',markdown,'elsarticle-3p',refs);
  assert.ok(tex.includes('\\title{Reviewed title}'));
  assert.ok(tex.includes('\\section*{Works Cited}'));
  assert.doesNotMatch(tex,/accessed|section\*\{References\}/);
});

test('overlapping DOI prefixes and conflicting identifiers do not suppress distinct editions', () => {
  const text='## Bibliography\n[1] A study of calibration. DOI 10.1234/cal.241.';
  const tex=manuscriptTex('Study',text,'article',[paper]);
  assert.ok(tex.includes('(accessed 2026-05-12)'));
  assert.doesNotMatch(tex,/href\{|\\section\*\{References\}/);
});

test('a missing TeX engine reports its actual subprocess failure', {skip:process.platform!=='linux'}, async () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = '/nonexistent-athena-test-directory';
    await assert.rejects(typeset('Study', 'Methods', 'article', new AbortController().signal), {code:'TYPESET_FAILED',message:/pdflatex.*ENOENT/});
  } finally {
    if(previous===undefined)delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
