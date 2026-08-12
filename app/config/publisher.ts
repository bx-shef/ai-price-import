/**
 * Publisher identity — THE single source (#297 п.1).
 *
 * These details used to live in three independent copies (`landing.ts`, `SiteFooter.vue`,
 * `BusinessCardModal.vue`) and had already drifted: the short name was written both «ИП Шевчик И.С.»
 * and «ИП Шевчик И. С.». A fourth copy sits in the previous legal documents on `dl.bx-shef.by`
 * carrying a DIFFERENT contact e-mail — which is exactly the kind of divergence that is harmless on
 * a landing page and expensive in a licence agreement, since the EULA and the privacy policy have to
 * name the same rights holder as the site does.
 *
 * `tests/publisher.test.ts` fails if any component re-introduces its own literal.
 *
 * Legal address, legal name and the contact e-mail were confirmed by the owner against the published
 * requisites page (2026-08-02) — they are no longer «open questions»; the same values must appear in
 * the EULA and the privacy policy, which is why they live here and nowhere else.
 *
 * ⚠ Bank details are deliberately NOT here: the licence is free of charge and the previous agreement
 * carried none, so putting an account number into a public page would publish more than the document
 * needs. They stay on the owner's own requisites page (https://offer.bx-shef.by/legal), откуда их и
 * берут договорные формы — `docs/contracts.md` §0.3 (#419). Секретом они не являются; отсутствие
 * здесь — про то, что страницам приложения и юридическим документам счёт не нужен.
 */
export const PUBLISHER = {
  /** Short legal name. ONE spelling — «И. С.» with a space, per Russian typography. */
  shortName: 'ИП Шевчик И. С.',
  /** Taxpayer number, digits only. Render with `unpLabel` where a caption is wanted. */
  unp: '192049017',
  unpLabel: 'УНП 192049017',
  /** Public contact e-mail of the site. ⚠ The legal documents may need a different one — owner call. */
  email: 'offer@bx-shef.by',
  phone: '+375 29 736-01-26',
  /** Same number in `tel:` form — no spaces or dashes. */
  phoneTel: '+375297360126',
  telegram: '@bxshefby',
  city: 'Минск, Беларусь',
  /** Full legal name of the rights holder — the form legal documents must use. */
  legalName: 'Индивидуальный предприниматель Шевчик Игорь Сергеевич',
  /** Registered address; the postal address is the same one (owner-confirmed). */
  address: 'пр. Дзержинского, д. 131, оф. 234, г. Минск, Республика Беларусь, 220025'
} as const

/** The person behind the sole proprietorship — business card and vCard. */
export const PUBLISHER_PERSON = {
  fullName: 'Игорь Шевчик',
  firstName: 'Игорь',
  middleName: 'Сергеевич',
  lastName: 'Шевчик'
} as const
