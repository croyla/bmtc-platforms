<script lang="ts">
  import LanguageSwitcher from "$lib/components/LanguageSwitcher.svelte";
  import { messages } from "$lib/stores/messages";
  import { currentSource, sources } from "$lib/stores/source";
  import { selectedItem, previousSelectedItem } from "$lib/stores/selectedItem";

  let isDropdownOpen = false;

  $: displayName = $messages.header().replace('%1', $currentSource
    ? ((($messages as any)[$currentSource]?.() as string | undefined) ?? $currentSource)
    : 'unknown');

  function toggleDropdown() {
    isDropdownOpen = !isDropdownOpen;
  }

  function selectSource(key: string) {
    isDropdownOpen = false;
    currentSource.set(key);
    selectedItem.set(undefined);
    previousSelectedItem.set(undefined);
    const url = new URL(window.location.href);
    url.searchParams.set('src', key);
    url.searchParams.delete('s');
    url.searchParams.delete('r');
    url.searchParams.delete('a');
    url.searchParams.delete('pf');
    history.replaceState({}, '', url.toString());
  }

  function getSourceLabel(key: string): string {
    return (($messages as any)[key]?.() as string | undefined) ?? key;
  }
</script>

<svelte:window on:keydown={(e) => { if (e.key === 'Escape') isDropdownOpen = false; }} />

<header class="cupertino-header">
  <div class="station-selector-wrapper">
    <button class="station-selector" on:click={toggleDropdown} aria-expanded={isDropdownOpen}>
      <span class="station-name">{displayName ?? $messages.select_station()}</span>
      <span class="material-icons chevron" class:open={isDropdownOpen}>expand_more</span>
    </button>
    {#if isDropdownOpen}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <div class="dropdown-backdrop" on:click={() => isDropdownOpen = false}></div>
      <div class="station-dropdown" role="listbox">
        {#each Object.keys($sources) as key}
          <button
            class="station-option"
            class:selected={$currentSource === key}
            role="option"
            aria-selected={$currentSource === key}
            on:click={() => selectSource(key)}
          >
            {getSourceLabel(key)}
          </button>
        {/each}
      </div>
    {/if}
  </div>
  <div class="language-switcher">
    <LanguageSwitcher />
  </div>
</header>

<style>
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&display=swap');
@import url('https://fonts.googleapis.com/icon?family=Material+Icons');
.cupertino-header {
  margin-top: 4px;
  margin-bottom: 10px;
  width: 100%;
  display: flex;
  align-items: center;
  z-index: 100;
  position: relative;
  padding-left: 16px;
  padding-right: 16px;
}
.station-selector-wrapper {
  flex: 1;
  position: relative;
}
.station-selector {
  display: flex;
  align-items: center;
  gap: 2px;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font-family: 'Manrope', sans-serif;
  font-size: 22px;
  font-weight: 700;
  color: #222;
  letter-spacing: -0.01em;
  text-align: left;
}
.station-selector:focus {
  outline: none;
}
.chevron {
  font-family: 'Material Icons';
  font-size: 24px;
  color: #444;
  transition: transform 0.2s ease;
  font-style: normal;
  font-weight: normal;
  letter-spacing: normal;
  -webkit-font-feature-settings: 'liga';
  font-feature-settings: 'liga';
  line-height: 1;
}
.chevron.open {
  transform: rotate(180deg);
}
.dropdown-backdrop {
  position: fixed;
  inset: 0;
  z-index: 190;
}
.station-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 200px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 4px 16px rgba(60,60,67,0.14);
  z-index: 200;
  padding: 6px 0;
  margin-top: 40px;
  overflow: hidden;
}
.station-option {
  display: block;
  width: 100%;
  padding: 13px 20px;
  font-family: 'Manrope', sans-serif;
  font-size: 16px;
  font-weight: 400;
  color: #222;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
}
.station-option:hover,
.station-option:focus {
  background: #f1f1f3;
  outline: none;
}
.station-option.selected {
  font-weight: 700;
  color: #008F45;
}
.language-switcher {
  margin-left: auto;
}
</style>