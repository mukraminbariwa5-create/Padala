// The Filipino translation: every sentence keeps its names and links, and common sentences come out right.
import test from 'node:test';
import assert from 'node:assert/strict';
import { words, patterns } from '../web/js/lang/fil.js';

const norm = (s) => s.replace(/\s+/g, ' ').trim();
function find(key) {
  if (words[key] !== undefined) return words[key];
  for (const [re, rep] of patterns) {
    const m = key.match(re);
    if (m) return typeof rep === 'function' ? rep(m, part) : key.replace(re, rep);
  }
  return null;
}
const part = (t) => find(norm(String(t))) ?? t;
const slots = (s) => (s.match(/\{\d+\}/g) || []).sort().join('');

test('every translation keeps the same {0} {1}… (names, links and bold words)', () => {
  for (const [en, fil] of Object.entries(words)) {
    assert.equal(slots(fil), slots(en), `placeholders differ for: ${en}`);
    assert.ok(fil.trim(), `empty translation for: ${en}`);
  }
});

test('sentences with names use the right Filipino markers', () => {
  assert.equal(find('Mukramin Ansao sent an update (version 2)'), 'Nagpadala si Mukramin Ansao ng update (bersyon 2)');
  assert.equal(find('You sent the project files (version 1)'), 'Ipinadala mo ang project files (bersyon 1)');
  assert.equal(find('Waiting for Ana to download {0} v2'), 'Hinihintay si Ana na i-download ang {0} v2');
  assert.equal(find('With Ana, Ben'), 'Kasama sina Ana, Ben');
  assert.equal(find('Sending to Camiela…'), 'Ipinapadala kay Camiela…');
  assert.equal(find('Remind Camiela'), 'Paalalahanan si Camiela');
});

test('numbers, times and statuses inside sentences', () => {
  assert.equal(find('1.5 MB of 12.0 MB · about 4 s left'), '1.5 MB ng 12.0 MB · mga 4 s pa');
  assert.equal(find('Sent 5 min ago'), 'Ipinadala 5 min ang nakalipas');
  assert.equal(find('Status: Given to client'), 'Status: Nasa kliyente na');
  assert.equal(find('Marked as Paid'), 'Na-mark bilang Bayad na');
  assert.equal(find('Paid{0}'), 'Bayad na{0}');
  assert.equal(find('Version 2 · 4 changed'), 'Bersyon 2 · 4 ang binago');
});

test('server errors, including ones that name a field', () => {
  assert.equal(find('Team name is required.'), 'Kailangan ang pangalan ng team.');
  assert.equal(find('Too many failed attempts. Try again in 5 minutes.'), 'Masyadong maraming maling subok. Subukan ulit pagkalipas ng 5 minuto.');
  assert.equal(find("That username and password don't match."), 'Hindi tugma ang username at password.');
});

test('an icon or number at the start of a sentence keeps its place', () => {
  assert.equal(find('{0} Move the project folder into {1} and name it {2}.'), '{0} Ilipat ang project folder sa {1} at pangalanan itong {2}.');
  assert.equal(find('{0}Check'), '{0}Suriin');
});

test('the result after an update, with its details', () => {
  assert.equal(
    find('{0} now has version 2. 3 files saved · 1 old file removed{1}{2}Next time Mukramin sends an update, just click {3}.'),
    'Nasa {0} na ang bersyon 2. 3 file ang na-save · 1 lumang file ang inalis.{1}{2}Sa susunod na magpadala si Mukramin ng update, i-click lang ang {3}.',
  );
});

test('text that is not in the dictionary is left alone', () => {
  assert.equal(find('booktrack-v2'), null);
  assert.equal(find('Mukramin Ansao {0}') ?? 'Mukramin Ansao {0}', 'Mukramin Ansao {0}');
});
