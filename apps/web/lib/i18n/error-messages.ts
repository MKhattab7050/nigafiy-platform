// What an API error means, in plain words, in English and Arabic.
//
// The API answers an error with { error: { code, message, details?, request_id? } }. The message is
// written for developers and logs (English, sometimes with field paths); the UI shows the sentence
// below for the `code` instead, in the user's language, and keeps the original behind "Details".
// An unknown code falls back to a sentence for its HTTP status, never to the raw message or JSON.
//
// Pure module (no React, no '@/' imports) so `node --test` can load it.

export type ErrorLocale = 'en' | 'ar';
export interface ErrorText {
  en: string;
  ar: string;
}

/** Anything that looks like an ApiError (status / code / message / details / requestId). */
export interface ErrorLike {
  status?: number;
  code?: string;
  message?: string;
  details?: unknown;
  requestId?: string;
}

// ---- Shared sentences (several codes mean the same thing to the user) --------------------------------

const NO_PERMISSION: ErrorText = { en: 'You don’t have permission to do this.', ar: 'ليس لديك صلاحية للقيام بهذا.' };
const ADMIN_ONLY: ErrorText = { en: 'Only an administrator can do this.', ar: 'هذا الإجراء متاح للمسؤولين فقط.' };
const OWNER_ONLY: ErrorText = { en: 'Only an owner of the organization can do this.', ar: 'هذا الإجراء متاح لمالكي المؤسسة فقط.' };
const SIGN_IN_AGAIN: ErrorText = { en: 'Your sign-in has ended. Please sign in again.', ar: 'انتهت جلسة الدخول. يُرجى تسجيل الدخول من جديد.' };
const NOT_FOUND: ErrorText = { en: 'This item could not be found. It may have been deleted.', ar: 'تعذّر العثور على هذا العنصر، وربما حُذف.' };
const CHECK_INPUT: ErrorText = { en: 'Some of the values entered are not accepted. Check them and try again.', ar: 'بعض القيم المدخلة غير مقبولة. راجعها ثم أعد المحاولة.' };
const NAME_TAKEN: ErrorText = { en: 'This name is already in use. Choose another one.', ar: 'هذا الاسم مستخدم من قبل. اختر اسمًا آخر.' };
const ALREADY_EXISTS: ErrorText = { en: 'This already exists.', ar: 'هذا العنصر موجود بالفعل.' };
const STILL_WAITING: ErrorText = { en: 'A previous request for this is still in progress. Wait for it to finish.', ar: 'ما زال طلب سابق لهذا الأمر قيد التنفيذ. انتظر حتى يكتمل.' };
const TOO_MANY: ErrorText = { en: 'Too many attempts. Wait a moment and try again.', ar: 'محاولات كثيرة جدًا. انتظر قليلًا ثم أعد المحاولة.' };
const NO_COLLECTOR: ErrorText = { en: 'No Sensor at this site is online right now, so Nigafiy cannot reach the device.', ar: 'لا يوجد مستشعر متصل في هذا الموقع حاليًا، لذا لا تستطيع Nigafiy الوصول إلى الجهاز.' };
const OUT_OF_SCOPE: ErrorText = { en: 'This address is outside the networks you allowed Nigafiy to watch.', ar: 'هذا العنوان خارج نطاق الشبكات التي سمحت لـNigafiy بمراقبتها.' };
const COMPUTER_OFFLINE: ErrorText = { en: 'The computer is not online right now. Try again when it is connected.', ar: 'الحاسوب غير متصل حاليًا. أعد المحاولة عندما يتصل.' };
const PROFILE_FORBIDS: ErrorText = { en: 'The permissions of this session do not allow this.', ar: 'صلاحيات هذه الجلسة لا تسمح بهذا الإجراء.' };
const POLICY_FORBIDS: ErrorText = { en: 'The access rules for this computer do not allow this.', ar: 'قواعد الوصول الخاصة بهذا الحاسوب لا تسمح بهذا الإجراء.' };
const SESSION_HOLDER_ONLY: ErrorText = { en: 'Only the person in charge of this remote session can do this.', ar: 'هذا الإجراء متاح فقط لمن يتولّى جلسة التحكم عن بُعد.' };
const QUICK_SUPPORT_RESTART: ErrorText = { en: 'This code no longer works. Ask the person to start Quick Support again.', ar: 'هذا الرمز لم يعد صالحًا. اطلب من الشخص تشغيل الدعم السريع من جديد.' };
const APK_BAD: ErrorText = { en: 'This file is not a usable Android app (APK). Upload the file again.', ar: 'هذا الملف ليس تطبيق أندرويد (APK) صالحًا. ارفع الملف من جديد.' };
const UPDATE_UNAVAILABLE: ErrorText = { en: 'Updates cannot be installed from here on this installation.', ar: 'لا يمكن تثبيت التحديثات من هنا في هذه النسخة.' };
const UPDATE_FAILED: ErrorText = { en: 'The update could not be installed. Try again later.', ar: 'تعذّر تثبيت التحديث. أعد المحاولة لاحقًا.' };
const ROUTER_NOT_READ: ErrorText = { en: 'Nigafiy has not read this router’s settings yet. Refresh it first.', ar: 'لم تقرأ Nigafiy إعدادات هذا الموجّه بعد. حدّثها أولًا.' };
const WOULD_CUT_OFF: ErrorText = { en: 'This would cut off Nigafiy or the computer you are using, so it was not done.', ar: 'هذا الإجراء سيقطع اتصال Nigafiy أو الحاسوب الذي تستخدمه، لذا لم يُنفَّذ.' };
const RESTORE_BLOCKED: ErrorText = { en: 'This backup cannot be restored right now.', ar: 'لا يمكن استعادة هذه النسخة الاحتياطية الآن.' };
const WRONG_STATE: ErrorText = { en: 'This can’t be done in its current state. Refresh the page and try again.', ar: 'لا يمكن تنفيذ هذا في الحالة الحالية. حدّث الصفحة ثم أعد المحاولة.' };
const NOT_ANDROID_READY: ErrorText = { en: 'The Nigafiy app on this phone does not allow this yet.', ar: 'تطبيق Nigafiy على هذا الهاتف لا يسمح بهذا بعد.' };
const WINDOWS_ONLY: ErrorText = { en: 'This is available on Windows computers only.', ar: 'هذه الميزة متاحة على حواسيب ويندوز فقط.' };
const NEEDS_SERVICE: ErrorText = { en: 'This needs the Nigafiy agent installed as a service on that computer.', ar: 'يتطلب هذا تثبيت وكيل Nigafiy كخدمة على ذلك الحاسوب.' };
const INVALID_RANGE: ErrorText = { en: 'The range is not valid. Check the start and end values.', ar: 'النطاق غير صالح. راجع قيمتَي البداية والنهاية.' };
const BAD_TIME: ErrorText = { en: 'The time entered is not valid.', ar: 'الوقت المدخل غير صالح.' };

/** Every error code the API (and this client) can produce, mapped to a plain sentence. */
export const ERROR_MESSAGES: Record<string, ErrorText> = {
  // ---- Client-side (lib/api.ts and friends) ----
  network_error: { en: 'Nigafiy can’t reach its server. Check that it is running and try again.', ar: 'تعذّر الوصول إلى خادم Nigafiy. تأكّد أنه يعمل ثم أعد المحاولة.' },
  timeout: { en: 'This took too long to answer. Try again.', ar: 'استغرق الرد وقتًا أطول من اللازم. أعد المحاولة.' },
  http_error: { en: 'Something went wrong. Try again.', ar: 'حدث خطأ ما. أعد المحاولة.' },
  error: { en: 'Something went wrong. Try again.', ar: 'حدث خطأ ما. أعد المحاولة.' },
  fs_op_failed: { en: 'The file operation failed on the computer.', ar: 'تعذّر تنفيذ عملية الملفات على الحاسوب.' },

  // ---- Generic server answers ----
  validation_error: CHECK_INPUT,
  bad_request: CHECK_INPUT,
  invalid_json: CHECK_INPUT,
  invalid_value: CHECK_INPUT,
  invalid_option: CHECK_INPUT,
  invalid_parameters: { en: 'Some settings are missing or not valid. Check them and try again.', ar: 'بعض الإعدادات ناقصة أو غير صالحة. راجعها ثم أعد المحاولة.' },
  invalid_config: { en: 'The settings of this check are not valid.', ar: 'إعدادات هذا الفحص غير صالحة.' },
  nothing_to_change: { en: 'Change at least one thing before saving.', ar: 'غيّر شيئًا واحدًا على الأقل قبل الحفظ.' },
  payload_too_large: { en: 'This is too large to send.', ar: 'حجم البيانات أكبر من المسموح بإرساله.' },
  internal_error: { en: 'Something went wrong on the Nigafiy server. Try again in a moment.', ar: 'حدث خطأ في خادم Nigafiy. أعد المحاولة بعد قليل.' },
  not_found: NOT_FOUND,
  conflict: ALREADY_EXISTS,
  rate_limited: TOO_MANY,
  csrf_rejected: {
    en: 'This request was blocked for your safety because the page was opened from an address Nigafiy does not know. Open Nigafiy from the desktop app or its usual address, then try again.',
    ar: 'حُظر هذا الطلب حفاظًا على أمانك لأن الصفحة فُتحت من عنوان لا يعرفه Nigafiy. افتح Nigafiy من تطبيق سطح المكتب أو من عنوانه المعتاد، ثم حاول مرة أخرى.',
  },

  // ---- Sign-in, accounts, organization ----
  unauthenticated: SIGN_IN_AGAIN,
  invalid_credentials: { en: 'The email or password is not correct.', ar: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' },
  invalid_password: { en: 'The password is not correct.', ar: 'كلمة المرور غير صحيحة.' },
  invalid_mfa_code: { en: 'The verification code is not correct.', ar: 'رمز التحقق غير صحيح.' },
  invalid_mfa_token: { en: 'The verification step expired. Please sign in again.', ar: 'انتهت مهلة خطوة التحقق. يُرجى تسجيل الدخول من جديد.' },
  mfa_locked: { en: 'Too many wrong codes. Try again in 15 minutes.', ar: 'أُدخلت رموز خاطئة كثيرة. أعد المحاولة بعد 15 دقيقة.' },
  mfa_required: { en: 'Your organization requires two-step verification. Set it up in your account first.', ar: 'تشترط مؤسستك التحقق بخطوتين. فعّله في حسابك أولًا.' },
  mfa_already_enabled: { en: 'Two-step verification is already on. Turn it off before setting it up again.', ar: 'التحقق بخطوتين مفعّل بالفعل. أوقفه قبل إعداده من جديد.' },
  mfa_not_enabled: { en: 'Two-step verification is not turned on.', ar: 'التحقق بخطوتين غير مفعّل.' },
  mfa_not_started: { en: 'Start setting up two-step verification first.', ar: 'ابدأ إعداد التحقق بخطوتين أولًا.' },
  policy_mfa_not_enrolled: { en: 'Set up an authenticator app in your account first.', ar: 'اضبط تطبيق المصادقة في حسابك أولًا.' },
  own_password_already_set: { en: 'This account already has a password you chose. Change it in your account settings.', ar: 'لهذا الحساب كلمة مرور اخترتها من قبل. غيّرها من إعدادات حسابك.' },
  own_password_not_set: { en: 'Set your own password first.', ar: 'عيّن كلمة المرور الخاصة بك أولًا.' },
  dbbackup_unavailable: { en: 'Backups from the app work on an installed copy with one organization.', ar: 'النسخ الاحتياطي من التطبيق متاح في النسخة المثبّتة التي فيها مؤسسة واحدة.' },
  dbbackup_folder_invalid: { en: 'Choose a folder on this computer or a USB drive by its full path, for example D:\\Nigafiy backups.', ar: 'اختر مجلدًا على هذا الكمبيوتر أو على فلاشة بمساره الكامل، مثل D:\\Nigafiy backups.' },
  dbbackup_folder_unwritable: { en: 'Nigafiy cannot write to that folder. Choose another one.', ar: 'لا تستطيع Nigafiy الكتابة في هذا المجلد. اختر مجلدًا آخر.' },
  dbbackup_failed: { en: 'The backup could not be written. Check the folder and free disk space, then try again.', ar: 'تعذّر حفظ النسخة الاحتياطية. تأكد من المجلد ومن وجود مساحة كافية، ثم أعد المحاولة.' },
  dbbackup_running: { en: 'A backup is being written. Try again in a moment.', ar: 'جارٍ حفظ نسخة احتياطية. أعد المحاولة بعد لحظات.' },
  dbbackup_restore_running: { en: 'A restore is in progress. Wait until it finishes.', ar: 'الاستعادة جارية. انتظر حتى تنتهي.' },
  dbbackup_file_not_found: { en: 'That backup file was not found.', ar: 'لم يُعثر على ملف النسخة الاحتياطية.' },
  dbbackup_file_invalid: { en: 'This file is not a complete Nigafiy backup.', ar: 'هذا الملف ليس نسخة احتياطية كاملة من Nigafiy.' },
  dbbackup_passphrase_needed: { en: 'This backup was made on another computer. Enter its backup passphrase.', ar: 'هذه النسخة صُنعت على كمبيوتر آخر. أدخل عبارة المرور الخاصة بها.' },
  dbbackup_key_missing: { en: 'This backup does not hold the key for its saved passwords. Router and email passwords would have to be entered again.', ar: 'هذه النسخة لا تحتوي على مفتاح كلمات المرور المحفوظة فيها. ستحتاج إلى إدخال كلمات مرور الراوتر والبريد من جديد.' },
  dbbackup_wrong_passphrase: { en: 'The backup passphrase is not correct.', ar: 'عبارة مرور النسخة الاحتياطية غير صحيحة.' },
  dbbackup_newer_version: { en: 'This backup was made by a newer version of Nigafiy. Update this copy first, then restore.', ar: 'هذه النسخة صُنعت بإصدار أحدث من Nigafiy. حدّث هذه النسخة أولًا ثم استعِدها.' },
  dbbackup_restore_failed: { en: 'The restore failed and nothing was changed.', ar: 'فشلت الاستعادة ولم يتغيّر شيء.' },
  invalid_reset_token: { en: 'This password reset link is not valid or has expired.', ar: 'رابط إعادة تعيين كلمة المرور غير صالح أو انتهت صلاحيته.' },
  registration_disabled: { en: 'Creating new accounts is turned off. Ask the owner to invite you.', ar: 'إنشاء الحسابات الجديدة متوقف. اطلب من المالك دعوتك.' },
  // Access from outside home (Settings, Tailscale / Cloudflare Tunnel)
  outside_access_unavailable: { en: 'Access from outside home cannot be set up on this server. Its administrator sets it up instead.', ar: 'لا يمكن إعداد الوصول من خارج المنزل على هذا الخادم. يتولى مسؤوله إعداده.' },
  registration_open: { en: 'Anyone can still create an account here. Close sign-up before opening the app from outside home.', ar: 'ما زال بإمكان أي شخص إنشاء حساب هنا. أغلق التسجيل قبل فتح التطبيق من خارج المنزل.' },
  tailscale_missing: { en: 'Tailscale is not installed on this computer. Install it from tailscale.com, then try again.', ar: 'برنامج Tailscale غير مثبت على هذا الحاسوب. ثبّته من tailscale.com ثم أعد المحاولة.' },
  tailscale_not_ready: { en: 'Sign in to Tailscale on this computer and turn on MagicDNS first.', ar: 'سجّل الدخول إلى Tailscale على هذا الحاسوب وفعّل MagicDNS أولًا.' },
  invalid_origin: { en: 'Enter the https address of the tunnel, like https://home.example.com — a name, not an IP address, with nothing after it.', ar: 'أدخل عنوان https الخاص بالنفق، مثل https://home.example.com — اسمًا لا عنوان IP، ودون أي شيء بعده.' },
  origin_exists: { en: 'This is already the address of the app.', ar: 'هذا هو عنوان التطبيق بالفعل.' },
  email_in_use: { en: 'An account with this email already exists.', ar: 'يوجد حساب بهذا البريد الإلكتروني بالفعل.' },
  account_deactivated: { en: 'Your account has been deactivated in this organization.', ar: 'أُوقف حسابك في هذه المؤسسة.' },
  no_organization: { en: 'This account does not belong to any organization.', ar: 'هذا الحساب لا ينتمي إلى أي مؤسسة.' },
  sso_session_pinned: { en: 'This sign-in came from your organization’s single sign-on. Sign in again to use another organization.', ar: 'تم هذا الدخول عبر الدخول الموحّد لمؤسستك. سجّل الدخول من جديد لاستخدام مؤسسة أخرى.' },
  forbidden: NO_PERMISSION,
  owner_required: OWNER_ONLY,
  invitation_needs_owner: { en: 'This invitation was not sent by an owner. Ask an owner for a new one.', ar: 'لم يُرسل هذه الدعوة أحد المالكين. اطلب دعوة جديدة من أحدهم.' },
  invitation_exists: { en: 'An invitation for this email is already waiting.', ar: 'توجد دعوة معلّقة لهذا البريد الإلكتروني بالفعل.' },
  invitation_not_found: { en: 'This invitation link is not valid or has expired.', ar: 'رابط الدعوة غير صالح أو انتهت صلاحيته.' },
  invite_expired: { en: 'The invitation has expired.', ar: 'انتهت صلاحية الدعوة.' },
  already_member: { en: 'This person is already a member of the organization.', ar: 'هذا الشخص عضو في المؤسسة بالفعل.' },
  not_a_member: { en: 'That person is not a member of this organization.', ar: 'هذا الشخص ليس عضوًا في هذه المؤسسة.' },
  member_in_other_organizations: { en: 'This person also belongs to another organization, so they reset their own password.', ar: 'ينتمي هذا الشخص إلى مؤسسة أخرى أيضًا، لذا يعيد تعيين كلمة مروره بنفسه.' },
  cannot_deactivate_self: { en: 'You cannot deactivate your own account.', ar: 'لا يمكنك إيقاف حسابك بنفسك.' },
  cannot_remove_self: { en: 'You cannot remove yourself from the organization.', ar: 'لا يمكنك إزالة نفسك من المؤسسة.' },
  last_owner: { en: 'The organization must keep at least one owner.', ar: 'يجب أن يبقى للمؤسسة مالك واحد على الأقل.' },
  not_email_channel: { en: 'Only an email channel can send account emails.', ar: 'يمكن لقناة البريد الإلكتروني وحدها إرسال رسائل الحساب.' },
  push_endpoint_invalid: { en: 'This browser offered a push address Nigafiy does not recognise. Try Chrome, Edge, Firefox or Safari, or use Telegram or ntfy.', ar: 'قدّم هذا المتصفح عنوان إشعارات لا يعرفه Nigafiy. جرّب Chrome أو Edge أو Firefox أو Safari، أو استخدم تيليجرام أو ntfy.' },
  push_keys_invalid: { en: 'The browser sent notification keys that cannot be used. Turn notifications off and on again.', ar: 'أرسل المتصفح مفاتيح إشعارات غير صالحة. أوقف الإشعارات ثم فعّلها مرة أخرى.' },
  not_telegram_channel: { en: 'This is not a Telegram channel.', ar: 'هذه ليست قناة تيليجرام.' },
  telegram_unreachable: { en: 'Telegram could not be reached. Check this computer’s internet connection and try again.', ar: 'تعذّر الوصول إلى تيليجرام. تحقّق من اتصال هذا الحاسوب بالإنترنت ثم أعد المحاولة.' },
  telegram_bot_rejected: { en: 'Telegram did not accept the bot token. Copy it again from @BotFather.', ar: 'لم يقبل تيليجرام رمز البوت. انسخه مرة أخرى من @BotFather.' },
  action_used: { en: 'This button was already used. Open the device in Nigafiy to change it.', ar: 'استُخدم هذا الزر من قبل. افتح الجهاز في Nigafiy لتغييره.' },
  action_expired: { en: 'This button has expired (buttons work for 24 hours). Open the device in Nigafiy to change it.', ar: 'انتهت صلاحية هذا الزر (تعمل الأزرار 24 ساعة). افتح الجهاز في Nigafiy لتغييره.' },
  invalid_smtp: { en: 'The mail server settings are not complete or not valid.', ar: 'إعدادات خادم البريد ناقصة أو غير صالحة.' },
  invalid_auth: { en: 'The sign-in details are not complete. Use either a token or a user name and password.', ar: 'بيانات الدخول ناقصة. استخدم رمز وصول أو اسم مستخدم وكلمة مرور.' },
  invalid_url: { en: 'This web address is not valid.', ar: 'عنوان الويب هذا غير صالح.' },
  invalid_timezone: { en: 'This time zone is not recognized.', ar: 'المنطقة الزمنية هذه غير معروفة.' },

  // ---- Sensors (collectors), agents, enrollment ----
  invalid_collector_credential: { en: 'The Sensor’s access key is not valid any more. Connect it again.', ar: 'مفتاح وصول المستشعر لم يعد صالحًا. اربطه من جديد.' },
  invalid_agent_credential: { en: 'The agent’s access key is not valid any more. Enroll it again.', ar: 'مفتاح وصول الوكيل لم يعد صالحًا. سجّله من جديد.' },
  invalid_endpoint_credential: { en: 'The computer’s access key is not valid any more. Enroll it again.', ar: 'مفتاح وصول الحاسوب لم يعد صالحًا. سجّله من جديد.' },
  invalid_enrollment_token: { en: 'This enrollment code is not valid, was already used, or has expired.', ar: 'رمز التسجيل غير صالح أو استُخدم من قبل أو انتهت صلاحيته.' },
  collector_not_active: { en: 'This Sensor is not connected and active.', ar: 'هذا المستشعر غير مرتبط أو غير نشط.' },
  not_pending: { en: 'A new enrollment code is only for items that have not enrolled yet.', ar: 'رمز التسجيل الجديد مخصص فقط لما لم يُسجَّل بعد.' },
  no_collector: NO_COLLECTOR,
  no_collector_online: NO_COLLECTOR,
  too_many_runs: { en: 'Several requests are already waiting on this Sensor. Wait for them to finish.', ar: 'هناك عدة طلبات تنتظر هذا المستشعر بالفعل. انتظر حتى تكتمل.' },
  not_here: { en: 'The agent is connected to another Nigafiy server.', ar: 'الوكيل متصل بخادم Nigafiy آخر.' },

  // ---- Network scope, addresses, devices ----
  out_of_scope: OUT_OF_SCOPE,
  not_in_scope: OUT_OF_SCOPE,
  router_out_of_scope: OUT_OF_SCOPE,
  public_not_allowed: { en: 'This is a public internet address. Allow public hosts for this check to reach it.', ar: 'هذا عنوان على الإنترنت العام. اسمح بالعناوين العامة لهذا الفحص كي يصل إليه.' },
  scope_overlap: { en: 'This range overlaps a network you already added.', ar: 'هذا النطاق يتداخل مع شبكة أضفتها من قبل.' },
  invalid_cidr: { en: 'This is not a valid network range (for example 192.168.1.0/24).', ar: 'هذا ليس نطاق شبكة صالحًا (مثل 192.168.1.0/24).' },
  not_private: { en: 'Only private home or office network ranges can be watched.', ar: 'يمكن مراقبة نطاقات الشبكات الخاصة (المنزلية أو المكتبية) فقط.' },
  ipv6_mapped: { en: 'Add the IPv4 range instead of this IPv6 form.', ar: 'أضف نطاق IPv4 بدلًا من هذه الصيغة في IPv6.' },
  ipv6_not_lan: { en: 'Only local IPv6 network ranges can be watched.', ar: 'يمكن مراقبة نطاقات IPv6 المحلية فقط.' },
  ipv6_too_large: { en: 'This IPv6 range is too large. A local network is normally a /64.', ar: 'نطاق IPv6 هذا كبير جدًا. الشبكة المحلية عادةً بحجم /64.' },
  invalid_scope: CHECK_INPUT,
  not_in_subnet: { en: 'This address is not inside any subnet of the site.', ar: 'هذا العنوان لا يقع ضمن أي شبكة فرعية للموقع.' },
  not_a_host_address: { en: 'This address cannot be given to a device.', ar: 'لا يمكن إسناد هذا العنوان إلى جهاز.' },
  reserved_address: { en: 'The network and broadcast addresses cannot be given to a device.', ar: 'لا يمكن إسناد عنوان الشبكة أو عنوان البث إلى جهاز.' },
  duplicate_address: { en: 'The same address is listed twice.', ar: 'العنوان نفسه مذكور مرتين.' },
  already_documented: { en: 'This address is already recorded.', ar: 'هذا العنوان مسجّل بالفعل.' },
  invalid_target: { en: 'This is not a valid address or host name to check.', ar: 'هذا ليس عنوانًا أو اسم مضيف صالحًا للفحص.' },
  no_address: { en: 'This device has no known IP address yet.', ar: 'لا يوجد عنوان IP معروف لهذا الجهاز بعد.' },
  no_device: { en: 'This computer is not linked to a device that the Sensor has seen.', ar: 'هذا الحاسوب غير مرتبط بجهاز رآه المستشعر.' },
  device_required: { en: 'Choose the device this should act on.', ar: 'اختر الجهاز الذي سيُطبَّق عليه هذا الإجراء.' },
  empty_target: { en: 'Select at least one device, check or Sensor.', ar: 'اختر جهازًا أو فحصًا أو مستشعرًا واحدًا على الأقل.' },
  other_site: { en: 'The device belongs to a different site.', ar: 'الجهاز يتبع موقعًا آخر.' },
  nothing_to_check: { en: 'No discovered device is inside the allowed networks yet.', ar: 'لا يوجد بعد جهاز مكتشف ضمن الشبكات المسموح بها.' },
  limit_reached: { en: 'You have reached the limit for this site.', ar: 'وصلت إلى الحد الأقصى المسموح به لهذا الموقع.' },
  already_added: ALREADY_EXISTS,
  name_in_use: NAME_TAKEN,
  invalid_plan: CHECK_INPUT,
  invalid_failure: CHECK_INPUT,

  // ---- Wake-on-LAN, ports, switches, quarantine ----
  no_mac: { en: 'Wake-on-LAN needs the device’s hardware (MAC) address, which has not been seen yet.', ar: 'يتطلب التشغيل عن بُعد عنوان MAC للجهاز، ولم يُرصد بعد.' },
  wol_ipv4_only: { en: 'Wake-on-LAN needs an IPv4 address, and this device was only seen over IPv6.', ar: 'يتطلب التشغيل عن بُعد عنوان IPv4، وهذا الجهاز لم يُرصد إلا عبر IPv6.' },
  not_located: { en: 'Nigafiy does not know yet which switch port this device is on.', ar: 'لا تعرف Nigafiy بعد منفذ المبدّل الذي يتصل به هذا الجهاز.' },
  not_direct: { en: 'Other devices share this port, so turning it off would cut them off too.', ar: 'أجهزة أخرى تشارك هذا المنفذ، لذا فإن إيقافه سيقطع اتصالها أيضًا.' },
  risky_port: { en: 'This port looks like a link to other network equipment or to Nigafiy itself. Give a reason to go ahead anyway.', ar: 'يبدو هذا المنفذ وصلةً إلى معدات شبكة أخرى أو إلى Nigafiy نفسها. اذكر سببًا للمتابعة رغم ذلك.' },
  already_quarantined: { en: 'This device is already isolated, or its isolation is in progress.', ar: 'هذا الجهاز معزول بالفعل، أو أن عزله قيد التنفيذ.' },
  port_quarantined: { en: 'A device on this port is isolated. Release it from the device page first.', ar: 'يوجد جهاز معزول على هذا المنفذ. ألغِ عزله من صفحة الجهاز أولًا.' },
  change_pending: STILL_WAITING,
  no_change: { en: 'Nothing would change: the port is already set this way.', ar: 'لن يتغير شيء: المنفذ مضبوط هكذا بالفعل.' },
  vlan_not_found: { en: 'This network segment (VLAN) does not exist on the switch.', ar: 'مقطع الشبكة (VLAN) هذا غير موجود على المبدّل.' },
  vlans_unknown: { en: 'Nigafiy could not read this switch’s network segments (VLANs) yet.', ar: 'لم تتمكن Nigafiy بعد من قراءة مقاطع الشبكة (VLAN) في هذا المبدّل.' },
  switch_disabled: { en: 'This switch is turned off in Nigafiy. Turn it on before changing its ports.', ar: 'هذا المبدّل معطّل في Nigafiy. فعّله قبل تغيير منافذه.' },
  write_not_configured: { en: 'Enter this switch’s write access details first; read-only access cannot change ports.', ar: 'أدخل بيانات الكتابة لهذا المبدّل أولًا؛ فصلاحية القراءة وحدها لا تكفي لتغيير المنافذ.' },

  // ---- Routers ----
  capabilities_unknown: ROUTER_NOT_READ,
  settings_unknown: ROUTER_NOT_READ,
  unsupported_on_router: { en: 'This router does not support this.', ar: 'هذا الموجّه لا يدعم هذه الميزة.' },
  already_requested: STILL_WAITING,
  confirm_required: { en: 'This disconnects devices. Confirm to go ahead.', ar: 'هذا الإجراء سيقطع اتصال بعض الأجهزة. أكّد للمتابعة.' },
  main_network_off: { en: 'Turn on the main Wi-Fi network before its guest network.', ar: 'شغّل شبكة Wi-Fi الرئيسية قبل شبكة الضيوف التابعة لها.' },
  ip_in_use: { en: 'Another device is using this address right now.', ar: 'جهاز آخر يستخدم هذا العنوان حاليًا.' },
  ip_reserved: { en: 'This address is already reserved for another device.', ar: 'هذا العنوان محجوز لجهاز آخر بالفعل.' },
  needs_reservation: { en: 'Reserve an address for this device on the router first.', ar: 'احجز عنوانًا لهذا الجهاز على الموجّه أولًا.' },
  not_reserved: { en: 'The router has no reservation for this device.', ar: 'لا يوجد حجز لهذا الجهاز على الموجّه.' },
  not_on_router: { en: 'The router does not list this device, so it cannot rename it.', ar: 'الموجّه لا يعرض هذا الجهاز، لذا لا يمكنه إعادة تسميته.' },
  no_schedule: { en: 'This device has no schedule on this router.', ar: 'لا يوجد جدول زمني لهذا الجهاز على هذا الموجّه.' },
  mac_required: { en: 'Enter the device’s hardware (MAC) address.', ar: 'أدخل عنوان MAC الخاص بالجهاز.' },
  mac_not_allowed: { en: 'A kept-free address has no hardware (MAC) address.', ar: 'العنوان المحجوز دون جهاز لا يحتاج إلى عنوان MAC.' },
  outside_lan: { en: 'This address is outside the router’s local network.', ar: 'هذا العنوان خارج الشبكة المحلية للموجّه.' },
  router_address: { en: 'This is the router’s own address.', ar: 'هذا هو عنوان الموجّه نفسه.' },
  gateway: { en: 'This is the router itself, so it cannot be blocked.', ar: 'هذا هو الموجّه نفسه، لذا لا يمكن حظره.' },
  own_machine: WOULD_CUT_OFF,
  collector_host: WOULD_CUT_OFF,
  management_port: { en: 'This port is used to manage the router itself and is never forwarded.', ar: 'يُستخدم هذا المنفذ لإدارة الموجّه نفسه ولا يُعاد توجيهه أبدًا.' },
  port_overlap: { en: 'These ports overlap an existing forwarding rule on the router.', ar: 'هذه المنافذ تتداخل مع قاعدة توجيه موجودة على الموجّه.' },
  too_many_ports: { en: 'A single rule cannot forward that many ports.', ar: 'لا يمكن لقاعدة واحدة توجيه هذا العدد من المنافذ.' },
  invalid_range: INVALID_RANGE,
  fingerprint_mismatch: { en: 'This fingerprint does not match the one the device presented.', ar: 'هذه البصمة لا تطابق البصمة التي قدّمها الجهاز.' },
  no_certificate: { en: 'Fetch the router’s certificate first.', ar: 'اجلب شهادة الموجّه أولًا.' },
  not_tls: { en: 'This router is reached without encryption, so there is no certificate to trust.', ar: 'يُتصل بهذا الموجّه دون تشفير، لذا لا توجد شهادة للوثوق بها.' },
  section_failed: { en: 'This part could not be read right now.', ar: 'تعذّرت قراءة هذا الجزء الآن.' },

  // ---- Configuration backup and restore ----
  no_credentials: { en: 'Enter the device’s sign-in details first.', ar: 'أدخل بيانات الدخول إلى الجهاز أولًا.' },
  content_unreadable: { en: 'This saved copy can no longer be opened because the app’s key changed.', ar: 'لم يعد ممكنًا فتح هذه النسخة المحفوظة لأن مفتاح التطبيق تغيّر.' },
  no_new_host_key: { en: 'The device has not presented a new security key.', ar: 'لم يقدّم الجهاز مفتاح أمان جديدًا.' },
  host_key_not_pinned: { en: 'Run one successful backup first so Nigafiy knows the device’s security key.', ar: 'نفّذ نسخًا احتياطيًا ناجحًا مرة واحدة أولًا كي تتعرّف Nigafiy على مفتاح أمان الجهاز.' },
  already_current: { en: 'This is already the latest saved configuration of the device.', ar: 'هذه بالفعل أحدث إعدادات محفوظة للجهاز.' },
  backup_in_progress: { en: 'A backup of this device is running. Wait until it finishes.', ar: 'يجري نسخ احتياطي لهذا الجهاز الآن. انتظر حتى يكتمل.' },
  restore_in_progress: { en: 'A restore of this device is already running.', ar: 'تجري استعادة لهذا الجهاز بالفعل.' },
  restore_unsupported: { en: 'Restoring is not supported for this kind of device.', ar: 'الاستعادة غير مدعومة لهذا النوع من الأجهزة.' },
  restore_vendor_unknown: { en: 'The device maker is not known yet. Run a backup or choose the maker first.', ar: 'الشركة المصنّعة للجهاز غير معروفة بعد. نفّذ نسخًا احتياطيًا أو اختر الشركة المصنّعة أولًا.' },
  raw_copy_missing: { en: 'No restorable copy of this version was kept.', ar: 'لم تُحفظ نسخة قابلة للاستعادة من هذا الإصدار.' },
  device_identity_mismatch: { en: 'This saved copy was taken from a different device.', ar: 'أُخذت هذه النسخة المحفوظة من جهاز مختلف.' },
  device_identity_unknown: { en: 'Nigafiy cannot tell whether this copy came from this device.', ar: 'لا تستطيع Nigafiy التأكد من أن هذه النسخة أُخذت من هذا الجهاز.' },
  other_device: { en: 'This copy belongs to another device. Confirm before restoring it.', ar: 'هذه النسخة تخص جهازًا آخر. أكّد قبل استعادتها.' },
  not_ready: RESTORE_BLOCKED,
  confirm_mismatch: { en: 'Type the device name exactly as shown to confirm.', ar: 'اكتب اسم الجهاز كما هو معروض تمامًا للتأكيد.' },
  confirm_other_device_mismatch: { en: 'The confirmation text does not match. Type it exactly as shown.', ar: 'نص التأكيد غير مطابق. اكتبه كما هو معروض تمامًا.' },
  wrong_target: { en: 'This version belongs to another device.', ar: 'هذا الإصدار يخص جهازًا آخر.' },
  discarded: { en: 'Restore this item before editing it.', ar: 'استعِد هذا العنصر قبل تعديله.' },

  // ---- Incidents, knowledge, playbooks, monitoring ----
  already_resolved: { en: 'This incident is already resolved.', ar: 'هذا الحادث محلول بالفعل.' },
  not_open: { en: 'Only an open incident can be acknowledged.', ar: 'لا يمكن الإقرار إلا بحادث مفتوح.' },
  not_resolved: { en: 'A resolution note is only for a resolved incident.', ar: 'ملاحظة الحل مخصصة للحوادث المحلولة فقط.' },
  not_approvable: { en: 'This finding cannot be marked as expected.', ar: 'لا يمكن وسم هذه الملاحظة بأنها متوقعة.' },
  fix_required: { en: 'Describe the fix before publishing.', ar: 'صِف طريقة الإصلاح قبل النشر.' },
  not_published: { en: 'Feedback can only be given on published articles.', ar: 'لا يمكن إبداء الرأي إلا على المقالات المنشورة.' },
  stale_revision: { en: 'Someone else saved this since you opened it. Reload to see their changes.', ar: 'حفظ شخص آخر تغييرات منذ أن فتحته. أعد التحميل لرؤية تغييراته.' },
  command_not_allowed: { en: 'This action cannot be used in automation.', ar: 'لا يمكن استخدام هذا الإجراء في الأتمتة.' },
  unknown_action: { en: 'One of the steps uses an action Nigafiy does not know.', ar: 'إحدى الخطوات تستخدم إجراءً لا تعرفه Nigafiy.' },
  auto_run_not_confirmed: { en: 'Running disruptive steps without asking needs your explicit confirmation.', ar: 'تشغيل الخطوات المؤثرة دون سؤال يتطلب تأكيدًا صريحًا منك.' },
  not_active: { en: 'This run has already finished.', ar: 'انتهى هذا التشغيل بالفعل.' },
  not_awaiting_approval: { en: 'This step is not waiting for approval.', ar: 'هذه الخطوة لا تنتظر الموافقة.' },
  self_approval: { en: 'You cannot approve this step yourself.', ar: 'لا يمكنك الموافقة على هذه الخطوة بنفسك.' },
  invalid_escalation: CHECK_INPUT,
  invalid_status: WRONG_STATE,
  invalid_time: { en: 'The Time Machine can only go back in time.', ar: 'آلة الزمن تعود إلى الماضي فقط.' },
  invalid_window: BAD_TIME,
  run_at_in_past: { en: 'The chosen time is in the past.', ar: 'الوقت المختار في الماضي.' },
  run_at_too_far: { en: 'The chosen time is more than a year ahead.', ar: 'الوقت المختار بعد أكثر من سنة.' },

  // ---- Fleet: computers, jobs, scripts, approvals, groups, profiles ----
  endpoint_offline: COMPUTER_OFFLINE,
  endpoint_not_active: { en: 'This computer is not enrolled or active.', ar: 'هذا الحاسوب غير مسجّل أو غير نشط.' },
  endpoint_online: { en: 'The computer is online: connect to it directly.', ar: 'الحاسوب متصل: اتصل به مباشرة.' },
  unsupported_by_platform: { en: 'This is not available on this kind of device.', ar: 'هذه الميزة غير متاحة على هذا النوع من الأجهزة.' },
  job_cancelled: { en: 'This job was cancelled.', ar: 'أُلغيت هذه المهمة.' },
  job_not_yours: { en: 'Only an administrator or the person who created this job can change it.', ar: 'لا يغيّر هذه المهمة إلا مسؤول أو من أنشأها.' },
  job_state: WRONG_STATE,
  nothing_to_rerun: { en: 'No computer failed in this run, so there is nothing to run again.', ar: 'لم يفشل أي حاسوب في هذا التشغيل، فلا شيء لإعادة تشغيله.' },
  install_started: { en: 'The computer already started this install, so it cannot be cancelled.', ar: 'بدأ الحاسوب هذا التثبيت بالفعل، لذا لا يمكن إلغاؤه.' },
  update_not_seen: { en: 'No managed computer has reported this update.', ar: 'لم يُبلغ أي حاسوب مُدار عن هذا التحديث.' },
  script_archived: { en: 'This script is archived.', ar: 'هذا البرنامج النصي مؤرشف.' },
  script_name_taken: NAME_TAKEN,
  script_not_runnable_by_technicians: { en: 'An administrator has not allowed technicians to run this script.', ar: 'لم يسمح المسؤول للفنيين بتشغيل هذا البرنامج النصي.' },
  approval_self: { en: 'Another administrator has to decide on your own request.', ar: 'يجب أن يبتّ مسؤول آخر في طلبك.' },
  approval_expired: { en: 'This request expired before anyone approved it.', ar: 'انتهت صلاحية هذا الطلب قبل أن يوافق عليه أحد.' },
  approval_not_pending: { en: 'This request is no longer waiting for approval.', ar: 'هذا الطلب لم يعد ينتظر الموافقة.' },
  unknown_group: { en: 'That group does not exist.', ar: 'هذه المجموعة غير موجودة.' },
  group_name_taken: NAME_TAKEN,
  too_many_tags: { en: 'A computer can have at most 20 tags.', ar: 'يمكن أن يحمل الحاسوب 20 وسمًا كحد أقصى.' },
  too_many_help_requests: { en: 'This computer already has several open help requests.', ar: 'لدى هذا الحاسوب عدة طلبات مساعدة مفتوحة بالفعل.' },
  help_request_closed: { en: 'This help request is closed.', ar: 'طلب المساعدة هذا مغلق.' },
  profile_builtin: { en: 'Built-in profiles cannot be changed or deleted. Create your own profile instead.', ar: 'لا يمكن تعديل الملفات المضمّنة أو حذفها. أنشئ ملفًا خاصًا بك بدلًا من ذلك.' },
  profile_in_use: { en: 'A group uses this profile. Change that group first.', ar: 'تستخدم إحدى المجموعات هذا الملف. غيّر تلك المجموعة أولًا.' },
  profile_name_taken: NAME_TAKEN,
  profile_not_found: { en: 'That permission profile no longer exists.', ar: 'ملف الصلاحيات هذا لم يعد موجودًا.' },
  profile_default_exceeds_max: { en: 'The default profile allows more than the maximum profile.', ar: 'الملف الافتراضي يسمح بأكثر مما يسمح به الملف الأقصى.' },
  profiles_missing: { en: 'The built-in permission profiles are missing. Restart Nigafiy.', ar: 'ملفات الصلاحيات المضمّنة مفقودة. أعد تشغيل Nigafiy.' },
  bad_profile: { en: 'This profile does not belong to the device’s site.', ar: 'هذا الملف لا يتبع موقع الجهاز.' },
  banner_mode_needs_unattended: { en: 'A minimized or hidden banner is only for unattended groups. Choose Unattended first, or keep the banner shown.', ar: 'الشريط المصغّر أو المخفي مخصص للمجموعات غير المراقَبة فقط. اختر «غير مراقَب» أولًا، أو أبقِ الشريط ظاهرًا.' },
  policy_role_not_allowed: { en: 'The access rules for this computer do not allow your role to connect.', ar: 'قواعد الوصول الخاصة بهذا الحاسوب لا تسمح لدورك بالاتصال.' },
  policy_ip_not_allowed: { en: 'The access rules for this computer do not allow connections from your address.', ar: 'قواعد الوصول الخاصة بهذا الحاسوب لا تسمح بالاتصال من عنوانك.' },
  policy_outside_hours: { en: 'The access rules for this computer do not allow sessions at this time.', ar: 'قواعد الوصول الخاصة بهذا الحاسوب لا تسمح بالجلسات في هذا الوقت.' },
  policy_mfa_required: { en: 'Enter a verification code before connecting to this computer.', ar: 'أدخل رمز التحقق قبل الاتصال بهذا الحاسوب.' },
  policy_mfa_invalid: { en: 'The verification expired or is not valid. Enter a new code.', ar: 'انتهت صلاحية التحقق أو أنه غير صالح. أدخل رمزًا جديدًا.' },
  profile_no_view: { en: 'The permissions of this session do not allow seeing the screen.', ar: 'صلاحيات هذه الجلسة لا تسمح برؤية الشاشة.' },
  recording_disabled_by_policy: { en: 'The access rules for this computer do not allow recording.', ar: 'قواعد الوصول الخاصة بهذا الحاسوب لا تسمح بالتسجيل.' },
  recording_required_by_policy: { en: 'The access rules for this computer require every session to be recorded.', ar: 'قواعد الوصول الخاصة بهذا الحاسوب تشترط تسجيل كل جلسة.' },
  recording_required_profile_cannot_record: { en: 'This computer requires recording, but the session’s permissions do not allow it.', ar: 'يشترط هذا الحاسوب التسجيل، لكن صلاحيات الجلسة لا تسمح به.' },

  // ---- Remote sessions, shells, recordings ----
  no_remote_session: { en: 'Start a remote session first.', ar: 'ابدأ جلسة تحكم عن بُعد أولًا.' },
  consent_pending: { en: 'The person has not accepted the remote session yet.', ar: 'لم يقبل الشخص جلسة التحكم عن بُعد بعد.' },
  session_mismatch: { en: 'This is not the open session. Refresh and try again.', ar: 'هذه ليست الجلسة المفتوحة. حدّث الصفحة ثم أعد المحاولة.' },
  not_a_participant: { en: 'You are not in this session. Ask the person in charge to invite you.', ar: 'لست مشاركًا في هذه الجلسة. اطلب ممن يتولّاها دعوتك.' },
  not_invited: { en: 'You were not invited to this session.', ar: 'لم تتلقَّ دعوة إلى هذه الجلسة.' },
  invite_self: { en: 'You are already in this session.', ar: 'أنت مشارك في هذه الجلسة بالفعل.' },
  invitee_role: { en: 'Only technicians, administrators and owners can join a remote session.', ar: 'لا ينضم إلى جلسة التحكم عن بُعد إلا الفنيون والمسؤولون والمالكون.' },
  not_joined: { en: 'Hand over only to someone who has joined the session.', ar: 'لا تسلّم الجلسة إلا لمن انضم إليها.' },
  already_holder: { en: 'This person is already in charge of the session.', ar: 'هذا الشخص يتولّى الجلسة بالفعل.' },
  holder_cannot_leave: { en: 'The person in charge ends the session or hands it over first.', ar: 'على من يتولّى الجلسة إنهاؤها أو تسليمها أولًا.' },
  not_session_holder: SESSION_HOLDER_ONLY,
  restart_in_progress: { en: 'A restart of this computer is already in progress.', ar: 'تجري إعادة تشغيل هذا الحاسوب بالفعل.' },
  confirmation_required: { en: 'Deleting files or folders needs your confirmation.', ar: 'حذف الملفات أو المجلدات يتطلب تأكيدك.' },
  safe_mode_needs_service: NEEDS_SERVICE,
  user_session_needs_service: NEEDS_SERVICE,
  safe_mode_windows_only: WINDOWS_ONLY,
  user_session_windows_only: WINDOWS_ONLY,
  user_session_unknown: { en: 'That Windows session is no longer on the computer. Refresh the list.', ar: 'جلسة ويندوز هذه لم تعد موجودة على الحاسوب. حدّث القائمة.' },
  too_many_streams: { en: 'Too many live windows are open. Close one first.', ar: 'نوافذ مباشرة كثيرة مفتوحة. أغلق إحداها أولًا.' },
  too_many_viewers: { en: 'This session already has as many viewers as it can take.', ar: 'وصلت هذه الجلسة إلى الحد الأقصى من المشاهدين.' },
  too_many_shell_windows: { en: 'This command window is already open in too many places.', ar: 'نافذة الأوامر هذه مفتوحة في أماكن كثيرة جدًا.' },
  shell_admin_only: ADMIN_ONLY,
  not_shell_operator: { en: 'Only the administrator who opened this command window can use it.', ar: 'لا يستخدم نافذة الأوامر هذه إلا المسؤول الذي فتحها.' },
  shell_closed: { en: 'This command window has closed.', ar: 'أُغلقت نافذة الأوامر هذه.' },
  recording_deleted: { en: 'This recording was deleted.', ar: 'حُذف هذا التسجيل.' },
  recording_in_progress: { en: 'Stop the recording, or end the session, before deleting it.', ar: 'أوقف التسجيل أو أنهِ الجلسة قبل حذفه.' },
  recordings_not_allowed: { en: 'Watching recordings is not allowed on this computer.', ar: 'مشاهدة التسجيلات غير مسموح بها على هذا الحاسوب.' },
  link_expired: { en: 'This link has expired. Open it again from the Nigafiy icon.', ar: 'انتهت صلاحية هذا الرابط. افتحه من جديد من أيقونة Nigafiy.' },
  link_not_opened: { en: 'Open the recording page first.', ar: 'افتح صفحة التسجيل أولًا.' },

  // ---- Quick Support ----
  quick_support_busy: { en: 'No free code is available right now. Try again.', ar: 'لا يتوفر رمز شاغر الآن. أعد المحاولة.' },
  quick_support_code_unknown: { en: 'No Quick Support program is waiting with this code. Check the code.', ar: 'لا يوجد برنامج دعم سريع ينتظر بهذا الرمز. تحقّق من الرمز.' },
  quick_support_expired: QUICK_SUPPORT_RESTART,
  quick_support_locked: QUICK_SUPPORT_RESTART,
  quick_support_wrong_pin: { en: 'The PIN is not correct.', ar: 'الرقم السري غير صحيح.' },
  quick_support_limited: { en: 'A Quick Support computer allows the session and its files only.', ar: 'حاسوب الدعم السريع يسمح بالجلسة وملفاتها فقط.' },
  quick_support_link_invalid: { en: 'This Quick Support program is no longer valid. Download a new one.', ar: 'برنامج الدعم السريع هذا لم يعد صالحًا. نزّل نسخة جديدة.' },
  quick_support_needs_code: { en: 'Connect to this computer with its Quick Support code and PIN.', ar: 'اتصل بهذا الحاسوب برمز الدعم السريع والرقم السري الخاصين به.' },
  quick_support_no_restart: { en: 'A Quick Support computer cannot be restarted and reconnected.', ar: 'لا يمكن إعادة تشغيل حاسوب الدعم السريع ثم الاتصال به من جديد.' },
  quick_support_not_built: { en: 'The Quick Support program is not available on this server.', ar: 'برنامج الدعم السريع غير متاح على هذا الخادم.' },

  // ---- Android ----
  android_apk_not_built: { en: 'The Nigafiy Android app is not available on this server.', ar: 'تطبيق Nigafiy لأندرويد غير متاح على هذا الخادم.' },
  android_control_not_enabled: { en: 'Remote control is not turned on on the phone yet.', ar: 'التحكم عن بُعد غير مفعّل على الهاتف بعد.' },
  android_feature_missing: { en: 'The Nigafiy app on this phone does not offer this yet. Update the app on the phone.', ar: 'تطبيق Nigafiy على هذا الهاتف لا يوفّر هذا بعد. حدّث التطبيق على الهاتف.' },
  android_files_not_allowed: NOT_ANDROID_READY,
  android_requires_device_owner: { en: 'Nigafiy does not fully manage this phone, so only inventory and checks are available.', ar: 'لا تدير Nigafiy هذا الهاتف إدارة كاملة، لذا يتاح الجرد والفحوص فقط.' },
  apk_empty: APK_BAD,
  apk_invalid: APK_BAD,
  apk_file_missing: APK_BAD,
  apk_file_corrupt: APK_BAD,
  apk_exists: { en: 'This app file is already uploaded.', ar: 'ملف التطبيق هذا مرفوع بالفعل.' },
  apk_too_large: { en: 'This app file is too large (100 MB at most).', ar: 'ملف التطبيق هذا كبير جدًا (100 ميغابايت كحد أقصى).' },

  // ---- Updates of Nigafiy itself ----
  updates_off: { en: 'Checking for updates is turned off on this installation.', ar: 'التحقق من التحديثات متوقف في هذه النسخة.' },
  no_update: { en: 'This computer already runs the newest version.', ar: 'يعمل هذا الحاسوب بأحدث إصدار بالفعل.' },
  no_component: UPDATE_UNAVAILABLE,
  no_engine: UPDATE_UNAVAILABLE,
  msi_managed: { en: 'Your administrator updates this installation.', ar: 'يتولّى المسؤول لديك تحديث هذه النسخة.' },
  store_managed: { en: 'The Microsoft Store updates this installation.', ar: 'يتولّى متجر مايكروسوفت تحديث هذه النسخة.' },
  download_in_progress: { en: 'An update is already downloading.', ar: 'يجري تنزيل تحديث بالفعل.' },
  nothing_staged: { en: 'No downloaded update is waiting to be installed.', ar: 'لا يوجد تحديث منزَّل بانتظار التثبيت.' },
  staged_changed: { en: 'The downloaded update changed on disk and was removed. Download it again.', ar: 'تغيّر التحديث المنزَّل على القرص فحُذف. نزّله من جديد.' },
  version_mismatch: { en: 'The downloaded update is a different version. Download it again.', ar: 'التحديث المنزَّل إصدار مختلف. نزّله من جديد.' },
  too_large: { en: 'This is larger than allowed.', ar: 'الحجم أكبر من المسموح به.' },
  engine_unreachable: { en: 'The Nigafiy Engine is not answering.', ar: 'محرك Nigafiy لا يستجيب.' },
  engine_refused: UPDATE_FAILED,
  engine_error: UPDATE_FAILED,
  update_rejected: UPDATE_FAILED,
};

/** Families of codes built at run time (`backup_${reason}`, `router_${state}`, …): checked after exact codes. */
export const ERROR_PREFIXES: readonly (readonly [prefix: string, text: ErrorText])[] = [
  ['backup_', { en: 'A backup of this device cannot run right now. Check its settings.', ar: 'لا يمكن نسخ هذا الجهاز احتياطيًا الآن. راجع إعداداته.' }],
  ['manifest_', { en: 'Nigafiy could not check for updates. Try again later.', ar: 'تعذّر على Nigafiy التحقق من التحديثات. أعد المحاولة لاحقًا.' }],
  ['router_', { en: 'Nigafiy cannot work with this router right now. Open the router page for details.', ar: 'لا تستطيع Nigafiy التعامل مع هذا الموجّه الآن. افتح صفحة الموجّه لمعرفة التفاصيل.' }],
  ['profile_forbids_', PROFILE_FORBIDS],
  ['policy_', POLICY_FORBIDS],
  ['quick_support_', QUICK_SUPPORT_RESTART],
  ['android_', NOT_ANDROID_READY],
  ['too_many_', TOO_MANY],
  ['invalid_', CHECK_INPUT],
  ['not_found', NOT_FOUND],
];

/** For a code nobody mapped: one plain sentence per HTTP status. */
export function statusFallback(status: number | undefined): ErrorText {
  const s = status ?? 0;
  if (s === 0) return ERROR_MESSAGES.network_error as ErrorText;
  if (s === 400 || s === 422) return CHECK_INPUT;
  if (s === 401) return SIGN_IN_AGAIN;
  if (s === 403) return NO_PERMISSION;
  if (s === 404) return NOT_FOUND;
  if (s === 408 || s === 504) return ERROR_MESSAGES.timeout as ErrorText;
  if (s === 409) return WRONG_STATE;
  if (s === 410) return { en: 'This is no longer available.', ar: 'هذا لم يعد متاحًا.' };
  if (s === 413) return ERROR_MESSAGES.payload_too_large as ErrorText;
  if (s === 423) return { en: 'This is locked for now. Try again later.', ar: 'هذا مقفل حاليًا. أعد المحاولة لاحقًا.' };
  if (s === 429) return TOO_MANY;
  if (s === 502 || s === 503) return { en: 'The service is not answering right now. Try again in a moment.', ar: 'الخدمة لا تستجيب الآن. أعد المحاولة بعد قليل.' };
  if (s >= 500) return ERROR_MESSAGES.internal_error as ErrorText;
  return ERROR_MESSAGES.error as ErrorText;
}

/** The plain sentence for an error code (exact, then family, then HTTP status). */
export function errorTextFor(code: string | undefined, status: number | undefined): ErrorText {
  if (code) {
    const exact = ERROR_MESSAGES[code];
    if (exact) return exact;
    for (const [prefix, text] of ERROR_PREFIXES) if (code.startsWith(prefix)) return text;
  }
  return statusFallback(status);
}

/** The sentence to show for an error, in `locale`. */
export function errorMessage(err: ErrorLike, locale: ErrorLocale): string {
  return errorTextFor(err.code, err.status)[locale];
}

/** Field-level problems of a validation error, as { path, message } (anything else is dropped). */
export function fieldIssues(details: unknown): { path: string; message: string }[] {
  if (!Array.isArray(details)) return [];
  return details
    .filter((d): d is { path?: unknown; message?: unknown } => typeof d === 'object' && d !== null)
    .map((d) => ({ path: typeof d.path === 'string' ? d.path : '', message: typeof d.message === 'string' ? d.message : '' }))
    .filter((d) => d.path || d.message);
}

/** Labels of the technical-details toggle. */
export const ERROR_UI: Record<'details' | 'code' | 'status' | 'message' | 'fields' | 'requestId', ErrorText> = {
  details: { en: 'Details', ar: 'التفاصيل' },
  code: { en: 'Code', ar: 'الرمز' },
  status: { en: 'HTTP status', ar: 'حالة HTTP' },
  message: { en: 'Server message', ar: 'رسالة الخادم' },
  fields: { en: 'Fields', ar: 'الحقول' },
  requestId: { en: 'Request ID', ar: 'معرّف الطلب' },
};

/** The original, technical facts of an error for the "Details" toggle ([label, value] pairs, untranslated values). */
export function errorTechnicalDetails(err: ErrorLike, locale: ErrorLocale): [label: string, value: string][] {
  const rows: [string, string][] = [];
  if (err.code) rows.push([ERROR_UI.code[locale], err.code]);
  if (err.status) rows.push([ERROR_UI.status[locale], String(err.status)]);
  if (err.message) rows.push([ERROR_UI.message[locale], err.message]);
  for (const f of fieldIssues(err.details)) rows.push([ERROR_UI.fields[locale], f.path ? `${f.path}: ${f.message}` : f.message]);
  if (err.requestId) rows.push([ERROR_UI.requestId[locale], err.requestId]);
  return rows;
}
