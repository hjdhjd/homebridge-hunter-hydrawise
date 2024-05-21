/* Copyright(C) 2022-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-gendocs.ts: Generate documentation for Homebridge Hydrawise.
 *
 */
import { featureOptionCategories, featureOptions } from "./hydrawise-options.js";

/* eslint-disable no-console */

const columnWidth = 45;

// Loop through all the feature option categories.
for(const category of featureOptionCategories) {

  console.log(" * [%s](#%s): %s", category.name, category.name.toLowerCase(), category.description);
}

// Let's separate the index from the details.
console.log("");

// Loop through all the feature option categories.
for(const category of featureOptionCategories) {

  // Output the category name.
  console.log("#### <A NAME=\"%s\"></A>%s", category.name.toLowerCase(), category.description);

  // Show the device scope.
  console.log("");

  // Header.
  console.log("| Option%s | Description", " ".repeat(Math.max(columnWidth - "Option".length + 3, 1)));
  console.log("|%s|%s", "-".repeat(columnWidth + 5), "-".repeat(columnWidth * 4));

  // Now output the category descriptions.
  for(const option of featureOptions[category.name]) {

    const expandedOption = category.name + (option.name ? "." : "") + option.name + (("defaultValue" in option) ? "<I>.Value</I>" : "");

    // console.log("  %s%s%s: %s (default: %s).", category.name, options.name ? "." : "", options.name, options.description, options.default);
    console.log("| `%s`%s | %s **(default: %s)**.",
      expandedOption,
      " ".repeat(Math.max(columnWidth - expandedOption.length + 1, 1)),
      option.description,
      option.defaultValue ?? (option.default ? "enabled" : "disabled"));
  }

  console.log("");
}
