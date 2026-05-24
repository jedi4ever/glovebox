We're working on a plugin for Claude Code that use msb (Micro Sandbox) to isolate  Claude code read.write,bash calls int a sandbox.

This will work using Claude hooks.
The hooks itself will be implemented in bash for fast execution. Some complex hooks will have that bash call typescript for deeper MSB SDK integration.

We can expect nodejs , msb and jq to be installed to make the plugin work.
We test this as part of the plugin, not as part of the project.
Run this in a hook at session start.
Scripts and hooks should be in the plugin directory


The project will use vitest and typescript.

We want to fully test the plugin by running tests with "clean" Claude code sessions: this means things like
- no memory
- completely seperate/clean config dir

We want full test coverage of features we add

This project uses git. so have the right .gitignore

This is claude plugin, so follow the conventions
The plugin goes into the plugins/glovebox directory
And we should be able to use this to add the plugin to claude
Dont't mix any plugin actions in tthe package.json
Plugin is not the output of the this project

Only our testing code stays in this project
The actually logic of controlling the msb sandbox goes in the plugin.

We don't have a dist from this project - the plugin is usuable directly
Tests stay at the project level.

Default to plain js for plugin code that is not bash
Add a plugin validate step using `claude plugin validate`


There is not reason for "--dangerously-skip-permissions".
When testing we should have the right settings approved.

When writing tests, you can use fixtures for specific cases for the plugin.

Test cases: 
- run them using a clean claude code session
- add unit tests too
- see if we plugin checks for the right software installed
- never write destructive commands inside a sandbox


Make the bash code simple and understandable
Bundle shared logic in a lib
Keep shell and js files short and readable


Keep the hooks clear names and seperarte in logic to follow
Make sure to do correct shell escsping where necessary

We want to control features using a config file .glovebox.yml:
for example enable/disalbe the mouting of the workdir
The config settings can also be set via env var

Use fixtures instead of creating config files adhoc

We use ANthropic API key because  just changing the claude config dir would make login fail 
Before you commit always run the tests, unless specifically told so

Code/Script/Test Files should be max 300 lines long . refactor to make files focused
Make filenames meaniful and consistent