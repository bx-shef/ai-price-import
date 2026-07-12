<script setup lang="ts">
// Mobile sticky CTA: the primary «обсудить интеграцию» call always within thumb
// reach. Appears once the hero scrolls out of view, hides when the brief form is on
// screen (so it never covers the form it points to). Landing gives the hero id="hero"
// and the brief section id="brief".
const props = withDefaults(defineProps<{
  briefId?: string
  label?: string
  goal?: string
}>(), {
  briefId: 'brief',
  label: 'Обсудить интеграцию',
  goal: 'sticky_cta_click'
})

const show = ref(false)
const { reachGoal } = useMetrikaGoal()

let pastHero = false
let briefInView = false
let heroObs: IntersectionObserver | null = null
let briefObs: IntersectionObserver | null = null

function update() {
  show.value = pastHero && !briefInView
}

onMounted(() => {
  // Guard for SSR/test environments (happy-dom) without IntersectionObserver.
  if (typeof IntersectionObserver === 'undefined') return

  const hero = document.getElementById('hero')
  const brief = document.getElementById(props.briefId)

  if (hero) {
    heroObs = new IntersectionObserver((entries) => {
      const e = entries[0]
      if (e) pastHero = !e.isIntersecting
      update()
    })
    heroObs.observe(hero)
  }

  if (brief) {
    briefObs = new IntersectionObserver((entries) => {
      const e = entries[0]
      if (e) briefInView = e.isIntersecting
      update()
    })
    briefObs.observe(brief)
  }
})

onUnmounted(() => {
  heroObs?.disconnect()
  briefObs?.disconnect()
})
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="translate-y-full opacity-0"
    enter-to-class="translate-y-0 opacity-100"
    leave-active-class="transition duration-150 ease-in"
    leave-from-class="translate-y-0 opacity-100"
    leave-to-class="translate-y-full opacity-0"
  >
    <div
      v-if="show"
      class="fixed inset-x-0 bottom-0 z-40 bg-gradient-to-t from-black/85 via-black/65 to-transparent px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:hidden"
    >
      <a
        :href="`#${props.briefId}`"
        class="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-cyan-500 text-base font-semibold text-slate-950 shadow-lg shadow-cyan-500/30 transition active:brightness-95"
        @click="reachGoal(props.goal)"
      >
        {{ props.label }}
      </a>
    </div>
  </Transition>
</template>
