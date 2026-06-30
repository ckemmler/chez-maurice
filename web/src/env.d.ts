/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Active theme for this request (set by middleware from ?theme= / cookie). */
    theme: string;
  }
}
