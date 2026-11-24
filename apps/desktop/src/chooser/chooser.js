'use strict';
// The program chooser that Apps & features "Modify" opens (Nigafiy.exe --choose-programs).
const T = {
  en: {
    title: 'Choose Nigafiy programs',
    intro: 'Nigafiy Hub is always installed. Pick the other programs this computer shows. The change applies the next time Nigafiy starts.',
    hub: 'Nigafiy Hub: home, settings and updates (always installed)',
    save: 'Save',
    close: 'Close',
    saving: 'Saving…',
    saved: 'Saved. Restart Nigafiy to apply the change.',
    msi: 'This copy was installed with the MSI package. Your administrator chooses the programs (the PROGRAMS property, through Group Policy or Intune).',
    unknown: 'Nigafiy could not tell how this copy was installed, so the choice cannot be saved here. Run the Nigafiy installer again to change it.',
    machine: 'This copy is installed for all users. Saving asks Windows for administrator approval.',
    cancelled: 'Not saved: administrator approval was cancelled.',
    failed: 'Not saved: ',
  },
  ar: {
    title: 'اختيار برامج Nigafiy',
    intro: 'يُثبَّت Nigafiy Hub دائمًا. اختر البرامج الأخرى التي يعرضها هذا الحاسوب. يُطبَّق التغيير عند تشغيل Nigafiy في المرة القادمة.',
    hub: 'Nigafiy Hub: الرئيسية والإعدادات والتحديثات (مثبّت دائمًا)',
    save: 'حفظ',
    close: 'إغلاق',
    saving: 'جارٍ الحفظ…',
    saved: 'تم الحفظ. أعد تشغيل Nigafiy لتطبيق التغيير.',
    msi: 'ثُبّتت هذه النسخة بحزمة MSI. يختار المسؤول البرامج (الخاصية PROGRAMS عبر نهج المجموعة أو Intune).',
    unknown: 'تعذّر على Nigafiy معرفة طريقة تثبيت هذه النسخة، لذا لا يمكن حفظ الاختيار هنا. شغّل مثبّت Nigafiy مرة أخرى لتغييره.',
    machine: 'هذه النسخة مثبّتة لكل المستخدمين. يطلب الحفظ موافقة المسؤول من Windows.',
    cancelled: 'لم يُحفظ: أُلغيت موافقة المسؤول.',
    failed: 'لم يُحفظ: ',
  },
};

/** Text with the technical part ("Nigafiy Radar", "PROGRAMS", an error code) kept left-to-right in Arabic. */
function setText(el, text) {
  el.textContent = '';
  const parts = String(text).split(/(Nigafiy(?: [A-Z][a-z]+)?|PROGRAMS|MSI|Intune|Windows|reg\.exe exit code \d+)/);
  for (const part of parts) {
    if (!part) continue;
    if (/^(Nigafiy|PROGRAMS|MSI|Intune|Windows|reg\.exe)/.test(part)) {
      const bdi = document.createElement('bdi');
      bdi.textContent = part;
      el.appendChild(bdi);
    } else el.appendChild(document.createTextNode(part));
  }
}

(async () => {
  const api = window.nigafiyPrograms;
  const s = await api.load();
  const lang = s.locale === 'ar' ? 'ar' : 'en';
  const t = T[lang];
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  const $ = (id) => document.getElementById(id);
  setText($('title'), t.title);
  setText($('intro'), t.intro);
  setText($('hub'), t.hub);
  $('save').textContent = t.save;
  $('close').textContent = t.close;
  const status = $('status');
  const show = (text, error = false) => {
    setText(status, text);
    status.className = error ? 'error' : '';
  };

  const boxes = [];
  for (const c of s.choices) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = c.id;
    box.checked = s.selected.includes(c.id);
    box.disabled = !s.writable;
    const span = document.createElement('span');
    setText(span, lang === 'ar' ? c.ar : c.en);
    label.append(box, ' ', span);
    $('choices').appendChild(label);
    boxes.push(box);
  }
  if (!s.writable) {
    $('save').hidden = true;
    show(s.scope === 'msi' ? t.msi : t.unknown);
  } else if (s.scope === 'machine') show(t.machine);

  $('close').addEventListener('click', () => void api.close());
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!s.writable) return;
    $('save').disabled = true;
    show(t.saving);
    const r = await api.save(boxes.filter((b) => b.checked).map((b) => b.value));
    $('save').disabled = false;
    if (r.ok) show(t.saved);
    else show(r.error === 'cancelled' ? t.cancelled : t.failed + r.error, true);
  });
})();
