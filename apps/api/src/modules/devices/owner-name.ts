/**
 * Whose device is it? Phones and computers are usually named after their owner by the operating system:
 * "Sara's iPhone" (mDNS friendly name), "Saras-iPhone" (the hostname Apple derives from it),
 * "Ahmed-PC", "iPhone-de-Marie". A 2013 study of campus Wi-Fi found a person's name in about one device
 * name in six. The guess is shown as a guess ("from its name") and a person can always change it.
 *
 * Deliberately narrow: the part before the device word must look like a first name (letters only, not a
 * word such as "my", "home" or "office"), and the device word must be a real device kind.
 */

const DEVICE_WORD =
  '(?:iphone|ipad|ipod|macbook(?:-?(?:pro|air))?|mac-?mini|imac|mac|watch|apple-?watch|galaxy[a-z0-9-]*|pixel[a-z0-9-]*|phone|mobile|tablet|tab|laptop|notebook|pc|desktop|computer|surface|kindle|ps\\d|playstation|xbox|switch)';

/** Words that are not names even though they sit where a name would. */
const NOT_A_NAME = new Set([
  'my', 'the', 'new', 'old', 'home', 'house', 'office', 'work', 'school', 'kids', 'kid', 'family', 'guest', 'guests',
  'admin', 'user', 'owner', 'living', 'room', 'bedroom', 'kitchen', 'main', 'spare', 'test', 'dev', 'android', 'apple',
  'samsung', 'huawei', 'xiaomi', 'oppo', 'vivo', 'realme', 'nokia', 'lenovo', 'dell', 'asus', 'acer', 'hp', 'msi',
  'microsoft', 'windows', 'desktop', 'laptop', 'gaming', 'game', 'media', 'tv', 'iphone', 'ipad', 'mac', 'macbook',
  'galaxy', 'pixel', 'redmi', 'poco', 'honor', 'infinix', 'tecno', 'mini', 'pro', 'max', 'plus', 'air', 'local', 'lan',
]);

const NAME_PART = /^[\p{L}]{2,20}$/u;

function cleanName(parts: string[]): string | null {
  const words = parts.map((p) => p.trim()).filter(Boolean);
  if (!words.length || words.length > 2) return null;
  for (const w of words) {
    if (!NAME_PART.test(w)) return null;
    if (NOT_A_NAME.has(w.toLowerCase())) return null;
  }
  // NetBIOS names are upper case ("AHMED-PC"): write those as "Ahmed"; keep any other casing.
  return words.map((w) => (w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

// Samsung's default name is "Galaxy A36", and people often keep just the model when they rename it:
// "محمد's A36". Only after a possessive: a bare "M15" or "A12" is as often a printer or camera model.
const GALAXY_SHORT = '(?:[asmfz]\\d{2}[a-z]?|note\\d{0,2}|fold\\d?|flip\\d?)';
const POSSESSIVE = new RegExp(`^(.+?)['’]s[\\s_-]+(?:${DEVICE_WORD}|${GALAXY_SHORT})\\b`, 'iu'); // Sara's iPhone, Ian Moffat's MacBook Pro, محمد's A36
const DASHED = new RegExp(`^([\\p{L}]+(?:-[\\p{L}]+)?)-${DEVICE_WORD}(?:-\\d+)?$`, 'iu'); // Saras-iPhone, Ahmed-PC, Ian-Moffats-iPhone
const PREFIXED = new RegExp(`^${DEVICE_WORD}[\\s_-]+(?:de|di|da|von|van|du)[\\s_-]+([\\p{L}]+)$`, 'iu'); // iPhone-de-Marie

/** "Saras-iPhone.local" -> "Sara"; null when the name does not clearly carry a person's name. */
export function ownerFromName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.trim().replace(/\.(local|lan|home|localdomain)\.?$/i, '');
  if (!name || name.length > 63) return null;

  const possessive = POSSESSIVE.exec(name);
  if (possessive) return cleanName(possessive[1]!.split(/[\s_-]+/));

  const prefixed = PREFIXED.exec(name);
  if (prefixed) return cleanName([prefixed[1]!]);

  const dashed = DASHED.exec(name);
  if (dashed) {
    const parts = dashed[1]!.split('-');
    // Apple derives the hostname from "Sara's iPhone" by dropping the apostrophe: "Saras-iPhone",
    // "Chriss-iPhone". So on Apple device words the trailing s is the possessive and comes off.
    const last = parts[parts.length - 1]!;
    const appleWord = /^(iphone|ipad|ipod|mac|macbook|imac|watch|apple)/i.test(name.slice(dashed[1]!.length + 1));
    if (appleWord && /s$/i.test(last) && last.length >= 4) parts[parts.length - 1] = last.slice(0, -1);
    return cleanName(parts);
  }
  return null;
}

/** The first owner found among the names a device announced (friendly names first, they keep the apostrophe). */
export function ownerFromNames(names: (string | null | undefined)[]): { owner: string; from: string } | null {
  for (const n of names) {
    const owner = ownerFromName(n);
    if (owner && n) return { owner, from: n.trim() };
  }
  return null;
}
