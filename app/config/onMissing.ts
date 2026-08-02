import type { ProductLookupConfig } from '~/types/mapping'

// Подписи настройки «что делать, если товар не найден» — ОДИН источник (#373).
//
// Их было три копии: список в `app/pages/settings.vue`, построчное предупреждение в `crmSyncCore`
// и текст жёсткой ошибки. Две последние цитировали вариант как «Внести как произвольную позицию» —
// пункта с таким названием в интерфейсе нет вовсе, и бухгалтер искал в списке несуществующую
// строку. Ссылаться на название пункта в тексте ошибки можно только из общего источника.

export const ON_MISSING_FIELD_LABEL = 'Что делать, если товар не найден в каталоге'

export const ON_MISSING_LABEL: Record<ProductLookupConfig['onMissing'], string> = {
  'freeform': 'Внести строку как есть, без товара из каталога',
  'skip-warn': 'Пропустить строку и предупредить'
}

/** Порядок для списка в настройках: дефолт первым (#373) — иначе первый пункт читается как дефолт. */
export const ON_MISSING_ITEMS: Array<{ label: string, value: ProductLookupConfig['onMissing'] }> = [
  { label: ON_MISSING_LABEL.freeform, value: 'freeform' },
  { label: ON_MISSING_LABEL['skip-warn'], value: 'skip-warn' }
]
