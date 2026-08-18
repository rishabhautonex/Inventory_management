"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  createComponentAction,
  updateComponentAction,
} from "@/app/actions/admin";
import { useToast } from "@/components/toast";
import {
  ErrorText,
  Field,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  textareaClass,
} from "@/components/ui";

export type PartFormValues = {
  name: string;
  mpn: string;
  manufacturer: string;
  category: string;
  searchTerms: string;
  productUrl: string;
  datasheetUrl: string;
  photoUrl: string;
  notes: string;
};

const EMPTY: PartFormValues = {
  name: "",
  mpn: "",
  manufacturer: "",
  category: "",
  searchTerms: "",
  productUrl: "",
  datasheetUrl: "",
  photoUrl: "",
  notes: "",
};

export function PartForm({
  componentId,
  initial,
}: {
  componentId?: string;
  initial?: PartFormValues;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [values, setValues] = useState<PartFormValues>(initial ?? EMPTY);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof PartFormValues>(key: K, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = componentId
        ? await updateComponentAction(componentId, values)
        : await createComponentAction(values);

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.show({
        tone: "success",
        message: componentId ? "Part saved." : "Part added.",
      });

      const id = componentId ?? ("id" in result ? result.id : undefined);
      router.push(id ? `/parts/${id}` : "/admin/parts");
      router.refresh();
    });
  }

  return (
    <>
      <div className="space-y-5 panel rounded-xl p-4 sm:p-6">
        <Field label="Name" required>
          <input
            className={inputClass}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="ESP32 DevKit v1"
            autoFocus
          />
        </Field>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="MPN" hint="Manufacturer part number. Must be unique.">
            <input
              className={inputClass}
              value={values.mpn}
              onChange={(e) => set("mpn", e.target.value)}
              placeholder="ESP32-DEVKITC-32D"
            />
          </Field>

          <Field label="Manufacturer">
            <input
              className={inputClass}
              value={values.manufacturer}
              onChange={(e) => set("manufacturer", e.target.value)}
              placeholder="Espressif"
            />
          </Field>
        </div>

        <Field label="Category">
          <input
            className={inputClass}
            value={values.category}
            onChange={(e) => set("category", e.target.value)}
            placeholder="Dev board"
          />
        </Field>

        <Field
          label="Search keywords"
          hint="Everything anyone might type looking for this. Spelling variants, nicknames, what it does. This is what makes the part findable."
        >
          <textarea
            className={textareaClass}
            value={values.searchTerms}
            onChange={(e) => set("searchTerms", e.target.value)}
            placeholder="esp32 wifi bluetooth microcontroller devkit wroom nodemcu"
          />
        </Field>

        <Field label="Product link" hint="Where to buy it again.">
          <input
            className={inputClass}
            type="url"
            inputMode="url"
            value={values.productUrl}
            onChange={(e) => set("productUrl", e.target.value)}
            placeholder="https://robu.in/…"
          />
        </Field>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Datasheet link">
            <input
              className={inputClass}
              type="url"
              inputMode="url"
              value={values.datasheetUrl}
              onChange={(e) => set("datasheetUrl", e.target.value)}
            />
          </Field>

          <Field label="Photo link">
            <input
              className={inputClass}
              type="url"
              inputMode="url"
              value={values.photoUrl}
              onChange={(e) => set("photoUrl", e.target.value)}
            />
          </Field>
        </div>

        <Field label="Notes">
          <textarea
            className={textareaClass}
            value={values.notes}
            onChange={(e) => set("notes", e.target.value)}
            placeholder="Anything worth knowing — pin quirks, which revision we have, who to ask."
          />
        </Field>

        <ErrorText>{error}</ErrorText>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          className={primaryButtonClass}
          onClick={submit}
          disabled={pending || !values.name.trim()}
        >
          {pending ? "Saving…" : componentId ? "Save part" : "Add part"}
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => router.back()}
        >
          Cancel
        </button>
      </div>
    </>
  );
}
