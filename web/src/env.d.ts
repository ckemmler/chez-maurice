/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Active theme for this request (set by middleware from ?theme= / cookie). */
    theme: string;
    /** The request comes from the garden's owner (proxy header, or GARDEN_OWNER=1). */
    owner: boolean;
    /** This note page was shared with the (non-owner) viewer by the owner. */
    shared: boolean;
  }
}
