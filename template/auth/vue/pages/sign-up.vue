<script setup lang="ts">
import { ref } from "vue";
import { auth } from "void/client";

const name = ref("");
const email = ref("");
const password = ref("");
const error = ref("");

async function submit() {
  const res = await auth.signUp.email({ name: name.value, email: email.value, password: password.value });
  if (res.error) error.value = res.error.message ?? "Sign up failed";
  else location.href = "/";
}
</script>

<template>
  <main>
    <h1>Sign up</h1>
    <form @submit.prevent="submit">
      <input v-model="name" name="name" placeholder="Name" required />
      <input v-model="email" name="email" type="email" placeholder="Email" required />
      <input v-model="password" name="password" type="password" placeholder="Password" minlength="8" required />
      <button type="submit">Sign up</button>
      <p v-if="error" role="alert">{{ error }}</p>
    </form>
    <a href="/sign-in">Already have an account?</a>
  </main>
</template>
