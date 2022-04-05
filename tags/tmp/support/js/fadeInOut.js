// 替换class达到淡入淡出的效果
//参考：https://segmentfault.com/a/1190000003067215
function fadeIn(e) {
    e.className = "bg fadein"
}

function fadeOut(e) {
    e.className = "bg"
}

var count = 0

function turnEntries() {
    let fadeOutEntryId = "clouds";
    let displayEntryId = "roseVideo";
    switch (count) {
        case 1: {
            fadeOutEntryId = "roseVideo"
            displayEntryId = "flowersContainer"
        }
    }
    const fadeOutEntries = document.getElementById(fadeOutEntryId);
    const displayEntries = document.getElementById(displayEntryId);

    displayEntries.style.display = "block"
    fadeOut(fadeOutEntries)
    count++
}


function hiddenEntry() {
    const entries = document.getElementById("clouds");
    entries.style.display = 'none'
}

//设置轮播间隔
setInterval(turnEntries, 5000);