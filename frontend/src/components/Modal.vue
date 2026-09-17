<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @mousedown.self="onMask">
      <div class="modal-card" :style="{ maxWidth: width }" role="dialog" aria-modal="true">
        <div class="modal-head">
          <span class="modal-title">{{ title }}</span>
          <button v-if="dismissable" class="modal-x" @click="$emit('close')">×</button>
        </div>
        <div class="modal-body"><slot /></div>
        <div v-if="$slots.footer" class="modal-foot"><slot name="footer" /></div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { watch, onUnmounted } from 'vue';

const props = defineProps({
  open: { type: Boolean, required: true },
  title: { type: String, default: '' },
  width: { type: String, default: '520px' },
  dismissable: { type: Boolean, default: true },
});
const emit = defineEmits(['close']);

function onKey(e) {
  if (e.key === 'Escape' && props.dismissable) emit('close');
}
watch(() => props.open, (v) => {
  if (v) window.addEventListener('keydown', onKey);
  else window.removeEventListener('keydown', onKey);
});
onUnmounted(() => window.removeEventListener('keydown', onKey));
function onMask() { if (props.dismissable) emit('close'); }
</script>
