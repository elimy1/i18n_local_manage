<template>
  <div class="panel">
    <h2>用户设置</h2>
    <p :title="'悬停提示'">修改密码</p>
    <span>{{ count }} 条记录</span>
    <button @click="save">保存修改</button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const count = ref(3)

function save() {
  console.log('保存中')
}
</script>
