'use strict';
// electron-builder msiProjectCreated hook (apps/desktop/package.json → build.msiProjectCreated):
// adds the PROGRAMS property to the MSI (docs/operations/installers.md, "Choose programs").
//
//   msiexec /i "Nigafiy 1.2.3.msi" /qn PROGRAMS=radar,watch,fleet
//
// The value is written to HKLM\Software\Nigafiy\Hub, value Programs (REG_SZ), which the engine reads
// at start and passes to the stack as NIGAFIY_PROGRAMS. Without PROGRAMS on the command line an
// upgrade keeps the value the earlier version wrote (RegistrySearch), and a first install writes
// "all". The engine checks the value (all, or a comma list of hub, radar, watch, guard, fleet, mind,
// toolbox) and ignores an invalid one, logging why.
const fs = require('node:fs');

// Fixed for the life of the product, like the upgrade code: Windows Installer tracks the
// registry value through this component.
const COMPONENT_GUID = '{7B0E7C1E-5A61-4C38-9E1B-2F4D9C6A8E31}';

const PROPERTIES = `
    <!-- Nigafiy: programs chosen at install time (apps/desktop/scripts/msi-programs.cjs) -->
    <Property Id="NIGAFIY_PROGRAMS_SAVED" Secure="yes">
      <RegistrySearch Id="NigafiyProgramsSaved" Root="HKLM" Key="Software\\Nigafiy\\Hub" Name="Programs" Type="raw"/>
    </Property>
    <Property Id="PROGRAMS" Secure="yes"/>
    <SetProperty Id="PROGRAMS" Action="NigafiyProgramsFromSaved" Value="[NIGAFIY_PROGRAMS_SAVED]" After="AppSearch" Sequence="both">NOT PROGRAMS AND NIGAFIY_PROGRAMS_SAVED</SetProperty>
    <SetProperty Id="PROGRAMS" Action="NigafiyProgramsDefault" Value="all" After="NigafiyProgramsFromSaved" Sequence="both">NOT PROGRAMS</SetProperty>
`;

const COMPONENT = `
      <Component Id="NigafiyProgramsSetting" Guid="${COMPONENT_GUID}">
        <RegistryValue Root="HKLM" Key="Software\\Nigafiy\\Hub" Name="Programs" Type="string" Value="[PROGRAMS]" KeyPath="yes"/>
      </Component>
`;

/** Returns the WiX source with the PROGRAMS property and its registry component added. */
function addProgramsProperty(wxs) {
  if (wxs.includes('NigafiyProgramsSetting')) return wxs;
  const product = wxs.lastIndexOf('</Product>');
  const group = wxs.lastIndexOf('</ComponentGroup>');
  if (product < 0 || group < 0 || group > product) throw new Error('msi-programs: the WiX project has no </ComponentGroup> before </Product>; electron-builder changed its template');
  return wxs.slice(0, group) + COMPONENT + wxs.slice(group, product) + PROPERTIES + wxs.slice(product);
}

module.exports = async function msiProjectCreated(projectFile) {
  fs.writeFileSync(projectFile, addProgramsProperty(fs.readFileSync(projectFile, 'utf8')));
};
module.exports.addProgramsProperty = addProgramsProperty;
module.exports.COMPONENT_GUID = COMPONENT_GUID;
