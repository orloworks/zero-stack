<script setup lang="ts">
import { ref } from "vue";
import { auth } from "void/client";

const email = ref("");
const password = ref("");
const error = ref("");

async function submit() {
  const res = await auth.signIn.email({ email: email.value, password: password.value });
  if (res.error) error.value = res.error.message ?? "Sign in failed";
  else location.href = "/";
}
</script>

<template>
  <main>
    <h1>Sign in</h1>
    <form @submit.prevent="submit">
      <input v-model="email" name="email" type="email" placeholder="Email" required />
      <input v-model="password" name="password" type="password" placeholder="Password" required />
      <button type="submit">Sign in</button>
      <p v-if="error" role="alert">{{ error }}</p>
    </form>
    <a href="/sign-up">Create an account</a>
  </main>
</template>
