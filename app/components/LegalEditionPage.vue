<script setup lang="ts">
import { computed } from 'vue'
import { findArchiveDoc, findEdition } from '~/utils/legalArchive'
import { loadEditionText } from '~/utils/legalArchiveTexts'

// Страница ОДНОЙ редакции по постоянному адресу (#415). Вся логика здесь, а четыре страницы под
// `app/pages/<документ>/archive/[date].vue` — по три строки: маршруты остаются статическими
// (пререндер + честный 404 на несуществующий документ), а тела у них больше нет.
//
// Раньше эти четыре файла были почти одинаковыми копиями, и в комментарии стояло, что иначе
// нельзя — «`import.meta.glob` требует литерального шаблона». Шаблон действительно обязан быть
// литеральным, но `'~~/docs/archive/**/*.md'` тоже литеральный: ограничение сборщика было названо
// верно, а вывод из него — нет.
const props = defineProps<{ slug: string }>()

const route = useRoute()
const date = computed(() => String(route.params.date ?? ''))
const doc = computed(() => findArchiveDoc(props.slug))
const edition = computed(() => findEdition(props.slug, date.value))

// ⚠ Неизвестная редакция — НАСТОЯЩИЙ 404, а не страница «такой редакции нет» с кодом 200. На
// `node-server` любой несуществующий адрес под индексируемым префиксом отдавал бы 200 без
// заголовка и без канонической ссылки, то есть неограниченное множество мягких 404 в выдаче.
if (!edition.value || !doc.value) {
  throw createError({ statusCode: 404, statusMessage: 'Редакция не найдена' })
}

// Текст грузится по требованию — см. `legalArchiveTexts`. Пустой (файл потеряли) — тоже 404:
// страница редакции без текста редакции ничего не доказывает.
const source = await loadEditionText(props.slug, date.value)
if (!source) throw createError({ statusCode: 404, statusMessage: 'Текст редакции недоступен' })
</script>

<template>
  <LegalDocument
    :source="source"
    :title="doc!.title"
    :path="`/${slug}/archive/${date}`"
    :description="`Редакция документа «${doc!.title}» от ${date}. Постоянный адрес, текст не изменяется.`"
    :archive-slug="slug"
    :edition="edition!"
  />
</template>
