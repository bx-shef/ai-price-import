<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { navigateTo } from '#app'
import CrossMIcon from '@bitrix24/b24icons-vue/outline/CrossMIcon'
import { useSettings } from '~/composables/useSettings'
import { useSettingsSync } from '~/composables/useSettingsSync'
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_PLACE_SETTINGS } from '~/config/b24'
import { SETTINGS_SECTIONS } from '~/config/settingsSections'
import { PORTAL_CONTENT_X, PORTAL_NAVBAR_CLASS } from '~/config/portalShell'

// In-portal settings: per-portal mapping (P3 UI). Layout `clear`, prerendered.
//
// РАСКЛАДКА (#523). Страница держит ОБОЛОЧКУ экрана: каркас портала, состояние загрузки, панель
// действий и механику закрытия слайдера. Сама форма — `SettingsForm.vue`; настройки едут в неё
// через `v-model`, потому что `useSettings()` не singleton и второй его экземпляр завёл бы вторую
// копию настроек, которую никто не сохраняет. Прежде здесь лежали 863 строки: оболочку читают
// структурные гарды по тексту шаблона, а правят оболочку и форму разные задачи.
definePageMeta({ layout: 'clear' })
useHead({ title: 'Настройки импорта', meta: [{ name: 'robots', content: 'noindex' }] }) // in-portal shell, see /app

const { mapping, loading, saving, saved, error, loadError, isAdmin, baseCurrency, currencyUnknown, loaded, load, save } = useSettings()
const { notifyReload } = useSettingsSync()
const { init: initB24, get: getFrame, auth: frameAuth, placementPlace, closeSlider } = useB24()
// How settings was reached, so Save/Cancel do the right «close»:
//  • isSlider — opened as a B24 slider (openSliderAppPage({place:'app-options'})) → close the slider
//    overlay (parent.closeApplication); the /app frame behind it live-reloads via the pull.
//  • inPortal (not slider) — reached by in-frame navigation (SDK slider unavailable) → return to /app.
//  • standalone (neither) — a plain page/direct link → stay put (Save shows ✓, Cancel reloads).
// ⚠ `null` — ещё не знаем (#408): со стартовым `false` экран на первом рендере считал себя «вне
// портала» и успевал показать значения по умолчанию до завершения рукопожатия.
const inPortal = ref<boolean | null>(null)
const isSlider = ref(false)
// Portal domain for the «завести валюту» link. Standalone → stays empty → no link rendered.
const portalDomain = ref('')
// Show the "read-only for non-admins" notice once settings have loaded (in a portal) and the
// caller isn't an admin. Writes are also blocked server-side + in useSettings.
const showReadOnly = computed(() => !loading.value && !error.value && !isAdmin.value)

onMounted(async () => {
  // Detect the portal frame + slider mode (inert/no-op standalone) so Save/Cancel close correctly.
  try {
    await initB24()
    inPortal.value = !!getFrame()
    isSlider.value = placementPlace() === APP_SLIDER_PLACE_SETTINGS
    portalDomain.value = frameAuth()?.domain ?? ''
  } catch { /* standalone → stay put on Save/Cancel */ }
  await load()
  await nextTick()
})

/** Explicit save (starter Save/Cancel pattern — no autosave). On success, notify other open
 *  instances to reload (pull `reload.options`), then close per how settings was opened. */
async function saveAndClose(): Promise<void> {
  await save()
  if (error.value) return // save() sets error; keep the form open so the admin can retry
  // ⚠ ЖДЁМ рассылку до закрытия: `closeAfter()` уничтожает фрейм, из которого она отправляется, и
  // `void` означал гонку — сообщение соседям терялось тем чаще, чем быстрее закрывался слайдер
  // (разбор PR #476). `notifyReload` не бросает: канал best-effort, отказ он объявляет сам.
  await notifyReload()
  await closeAfter()
}
/** Cancel: close per how settings was opened (slider → close overlay, in-frame → back to /app); as a
 *  plain page reload the server copy. ⚠ Построчные редакторы формы пересеваются САМИ — `load()`
 *  заменяет объект настроек, и форма ловит это сменой ссылки (см. `SettingsForm.vue`). Прежде
 *  пересев звала эта функция, и при разборе экрана вызов ушёл бы в `null`: до прихода настроек
 *  форма под `ScreenState` вообще не смонтирована. */
async function cancel(): Promise<void> {
  if (isSlider.value || inPortal.value) {
    await closeAfter()
    return
  }
  await load()
}
/** Close the settings view: as a slider → close the B24 overlay (parent.closeApplication); as an
 *  in-frame page → navigate back to /app (same-origin SPA route, the frame handshake survives so the
 *  token stays valid); standalone → no-op (caller handles Save-stays / Cancel-reload). */
async function closeAfter(): Promise<void> {
  if (isSlider.value) {
    await closeSlider()
    return
  }
  if (inPortal.value) await navigateTo('/app')
}

// Навигация по разделам вместо схлопывания (#259): в аккордеоне закрытая секция ПРЯТАЛА настройки.
// Якоря — общие с формой (`app/config/settingsSections.ts`), иначе полоса ведёт в никуда.
const sectionNav = computed(() => SETTINGS_SECTIONS.map(x => ({ label: x.label, to: `#${x.id}` })))
</script>

<template>
  <!-- CLIENT-ONLY: depends on the B24 frame handshake; prerender+hydrate framed mismatched (see /app). -->
  <ClientOnly>
    <!-- Панель каркаса (#259): навбар и тулбар — в #header, контент — в #body. `:b24ui` МЕРДЖИТСЯ
         (tailwind-merge), не заменяет базу — `min-h-svh`/прокрутка/паддинг тела сняты явными
         конфликтующими классами `min-h-0`/`overflow-y-visible`/`gap-0`/`sm:p-0` (см. /app). -->
    <B24DashboardPanel
      id="settings"
      :b24ui="{ root: 'relative flex flex-col w-full min-w-0 min-h-0', body: 'flex flex-col gap-0 overflow-y-visible sm:p-0' }"
    >
      <template #header>
        <!-- Same chrome as /metrics: навбар каркаса (#259) с кнопкой закрытия. Механика закрытия не
             тронута — по-прежнему `cancel`, чтобы in-frame фолбэк возвращал на /app. -->
        <!-- ⚠ Отступы навбара выровнены с колонкой контента (`px-4 sm:px-6`): родные `ps-2 lg:ps-4`
             ставили заголовок левее карточек, и на широком экране шапка читалась отдельно от
             страницы. Та же правка, что на `/app` (10.08.2026). -->
        <B24DashboardNavbar
          :toggle="false"
          title="Настройки импорта"
          :b24ui="{ root: PORTAL_NAVBAR_CLASS }"
        >
          <template #leading>
            <B24Button
              :icon="CrossMIcon"
              color="air-tertiary-no-accent"
              size="xs"
              :aria-label="isSlider ? 'Закрыть' : 'Вернуться к обзору'"
              @click="cancel"
            />
          </template>
        </B24DashboardNavbar>

        <!-- Тулбар каркаса: навигация по разделам вместо схлопывания (#259). Аккордеон прятал
             настройки — «что вообще можно настроить» было видно только по заголовкам секций. -->
        <B24DashboardToolbar v-if="!showReadOnly">
          <!-- ⚠ Полоса разделов прокручивается ВНУТРИ СЕБЯ: четыре пункта на телефоне занимают
               597 px при экране 375, и без этого страница обрезала бы их молча (замерено). Своя
               прокрутка у полосы — не нарушение правила «никакой горизонтальной прокрутки»:
               оно про страницу, а не про ленту вкладок. -->
          <div class="-mx-1 min-w-0 overflow-x-auto px-1">
            <!-- Без `highlight`: vue-router не учитывает hash при сравнении активного маршрута,
               поэтому подсветка горела бы на всех четырёх пунктах разом. -->
            <B24NavigationMenu
              :items="sectionNav"
              orientation="horizontal"
            />
          </div>
        </B24DashboardToolbar>
      </template>

      <template #body>
        <!-- ⚠ Колонка НЕ капается по ширине (10.08.2026, та же правка, что на `/app`). В слайдере
             720 ничего не изменилось: 720 − 48 отступов = ровно те же 672 px, из которых ширина
             слайдера и выведена. Изменилось поведение НА ШИРОКОМ окне — раньше там оставался узкий
             столбик посередине с заголовком где-то слева от него. -->
        <div :class="[PORTAL_CONTENT_X, 'flex min-h-dvh w-full flex-col py-4 pb-0 sm:py-6']">
          <p class="mb-4 text-sm text-(--ui-color-base-3)">
            Здесь вы задаёте, куда приложение вносит товары из документов и как ищет их в вашем каталоге.
          </p>
          <!-- ⚠ Только НЕ-загрузочные ошибки (сохранение): при отказе загрузки о нём говорит
               `ScreenState` ниже, и без этого условия человек видел два алерта об одном отказе. -->
          <B24Alert
            v-if="error && !loadError"
            class="mb-4"
            color="air-primary-warning"
            :title="error"
          />

          <B24Alert
            v-if="showReadOnly"
            class="mb-4"
            color="air-primary-warning"
            title="Настройки доступны только администратору"
            description="Менять эти настройки может только администратор портала Bitrix24. Попросите его открыть эту страницу."
          />

          <!-- ⚠ Форма — под состоянием загрузки (#408). Прежде она рисовалась ДО прихода серверной
               копии, то есть со значениями по умолчанию: администратор видел настройки, которых не
               выбирал, и они на глазах подменялись сохранёнными. На медленной сети это читается как
               сброс настроек — худшая из возможных трактовок для экрана, где лежит конфигурация
               записи в CRM. Прежнее полумерное `opacity-50` от этого не спасало: приглушённые
               значения всё равно НАПИСАНЫ, а человек читает то, что видит, а не то, что кликабельно.
               `inert` — вне портала: там фрейм-токена нет, загрузка не начнётся никогда. -->
          <ScreenState
            :loaded="loaded"
            :error="loadError"
            :inert="inPortal === false"
            :on-retry="() => { void load() }"
          >
            <template #skeleton>
              <SettingsLoader />
            </template>
            <SettingsForm
              v-if="!showReadOnly"
              v-model="mapping"
              :loaded="loaded"
              :is-admin="isAdmin"
              :base-currency="baseCurrency"
              :currency-unknown="currencyUnknown"
              :in-portal="inPortal"
              :error="error"
              :portal-domain="portalDomain"
            />

            <!-- Действия — в нижней панели окна, как у штатного слайдера b24ui (#523). Прежде они
                 стояли в конце содержимого: на этом экране до них было около двух тысяч пикселей
                 прокрутки, и правивший первое поле до «Сохранить» не доходил. -->
            <SliderActions v-if="!showReadOnly">
              <B24Button
                color="air-primary-success"
                :loading="saving"
                :disabled="saving || loading || !isAdmin"
                :label="saving ? 'Сохраняем…' : 'Сохранить'"
                @click="saveAndClose"
              />
              <B24Button
                color="air-tertiary"
                :disabled="saving"
                label="Отмена"
                @click="cancel"
              />
              <span
                v-if="saved && !saving"
                class="text-sm text-(--ui-color-accent-main-success)"
                role="status"
                aria-live="polite"
              >Настройки сохранены ✓</span>
              <!-- Сборка — служебная подпись у правого края панели, чтобы кнопки остались по центру. -->
              <template #end>
                <BuildFooter bare />
              </template>
            </SliderActions>
          </ScreenState>
        </div>
      </template>
    </B24DashboardPanel>
  </ClientOnly>
</template>
